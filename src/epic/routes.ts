import type { FastifyInstance, FastifyRequest } from "fastify";

import type { TokenClaims } from "../auth.js";
import type { PathGenConfig } from "../config.js";
import type { UserStore } from "../users/userStore.js";
import {
  buildEpicAuthorizeUrl,
  consumeMemoryEpicLinkState,
  createEpicLinkStateValue,
  epicLinkExpiresAt,
  exchangeEpicAuthorizationCode,
  fetchEpicUserInfo,
  fingerprintClientId,
  rememberEpicLinkState,
  resolveEpicDisplayName,
  withTimeout,
  type EpicOAuthConfig,
} from "./oauth.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

function epicConfigFrom(config: PathGenConfig): EpicOAuthConfig | null {
  if (!config.epicClientId || !config.epicClientSecret || !config.epicRedirectUri) {
    return null;
  }
  return {
    clientId: config.epicClientId,
    clientSecret: config.epicClientSecret,
    redirectUri: config.epicRedirectUri,
  };
}

function epicUnavailable(reply: {
  code: (status: number) => { send: (body: unknown) => unknown; type: (t: string) => { send: (body: unknown) => unknown } };
  type: (t: string) => { send: (body: unknown) => unknown };
}) {
  return reply.code(503).send({
    error: "Epic Games OAuth is not configured on this PathGen server.",
    code: "epic_unavailable",
  });
}

function cloudUnavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(503).send({
    error: "Supabase is not configured on this PathGen server.",
    code: "supabase_unavailable",
  });
}

function successHtml(displayName: string): string {
  const safe = displayName.replace(/[<>&"']/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Epic Games linked</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: #0b0d10; color: #e8eaed;
    }
    main {
      max-width: 28rem; padding: 2rem; text-align: center;
      border: 1px solid #252a33; border-radius: 12px; background: #12151a;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { margin: 0; color: #9aa3af; line-height: 1.5; }
    strong { color: #e8eaed; }
  </style>
</head>
<body>
  <main>
    <h1>Epic Games connected</h1>
    <p>Linked as <strong>${safe}</strong>. You can close this window and return to Zer0.</p>
  </main>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "EPIC_AUTH_SUCCESS", displayName: ${JSON.stringify(displayName)} }, "*");
      }
    } catch (_) {}
    setTimeout(function () { try { window.close(); } catch (_) {} }, 1200);
  </script>
</body>
</html>`;
}

function errorHtml(message: string): string {
  const safe = message.replace(/[<>&"']/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Epic Games link failed</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: #0b0d10; color: #e8eaed;
    }
    main {
      max-width: 28rem; padding: 2rem; text-align: center;
      border: 1px solid #252a33; border-radius: 12px; background: #12151a;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #f87171; }
    p { margin: 0; color: #9aa3af; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Could not link Epic Games</h1>
    <p>${safe}</p>
  </main>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "EPIC_AUTH_ERROR", message: ${JSON.stringify(message)} }, "*");
      }
    } catch (_) {}
  </script>
</body>
</html>`;
}

export async function registerEpicRoutes(
  app: FastifyInstance,
  config: PathGenConfig,
  users: UserStore,
): Promise<void> {
  app.get("/api/epic/start", async (request, reply) => {
    const epic = epicConfigFrom(config);
    if (!epic) return epicUnavailable(reply);

    const tester = (request as AuthedRequest).tester;
    const state = createEpicLinkStateValue();
    const expiresAt = epicLinkExpiresAt();

    // Always store in memory first so this endpoint never hangs on cloud I/O.
    rememberEpicLinkState(state, tester.testerId, tester.inviteCode, expiresAt);

    if (users.enabled) {
      try {
        await withTimeout(
          users.saveEpicOAuthState(state, {
            testerId: tester.testerId,
            inviteCode: tester.inviteCode,
            expiresAt,
          }),
          2500,
          "epic oauth state persist",
        );
      } catch (error) {
        app.log.warn({ err: error, testerId: tester.testerId }, "Epic OAuth Supabase persist skipped");
      }
    }

    const url = buildEpicAuthorizeUrl(epic, state);

    app.log.info(
      {
        event: "epic_oauth_start",
        testerId: tester.testerId,
        clientFingerprint: fingerprintClientId(epic.clientId),
      },
      "Epic OAuth start",
    );

    return { url, state };
  });

  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>("/api/epic/callback", async (request, reply) => {
    const epic = epicConfigFrom(config);
    if (!epic) {
      return reply.type("text/html").code(503).send(errorHtml("Epic OAuth is not configured."));
    }

    const { code, state, error, error_description } = request.query;
    if (error) {
      const detail = error_description || error;
      return reply.type("text/html").code(400).send(errorHtml(`Epic denied access: ${detail}`));
    }
    if (!code || !state) {
      return reply.type("text/html").code(400).send(errorHtml("Missing authorization code or state."));
    }

    let pending =
      consumeMemoryEpicLinkState(state) ??
      (users.enabled
        ? await withTimeout(users.consumeEpicOAuthState(state), 4000, "epic oauth state lookup").catch(
            () => null,
          )
        : null);

    if (!pending) {
      return reply
        .type("text/html")
        .code(400)
        .send(errorHtml("This link expired or was already used. Start again from Zer0."));
    }

    try {
      const token = await exchangeEpicAuthorizationCode(epic, code);
      const accessToken = token.access_token;
      if (!accessToken) throw new Error("Epic token response missing access_token");

      let accountId = typeof token.account_id === "string" ? token.account_id : "";
      let displayName = accountId;
      try {
        const userInfo = await fetchEpicUserInfo(accessToken);
        accountId = userInfo.sub || accountId;
        displayName = resolveEpicDisplayName(userInfo, token);
      } catch (userInfoError) {
        app.log.warn({ err: userInfoError }, "Epic userInfo failed; falling back to token account_id");
        if (!accountId) throw userInfoError;
      }

      if (!accountId) throw new Error("Could not resolve Epic account id");

      if (!users.enabled) {
        return reply
          .type("text/html")
          .code(503)
          .send(
            errorHtml(
              "Cloud user sync is offline. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the PathGen Railway service, then redeploy.",
            ),
          );
      }

      const user = await withTimeout(
        users.linkEpicAccount(pending.testerId, pending.inviteCode, {
          epicAccountId: accountId,
          epicDisplayName: displayName,
        }),
        8000,
        "epic account link",
      );

      app.log.info(
        {
          event: "epic_oauth_linked",
          testerId: pending.testerId,
          epicAccountId: user.epicAccountId,
        },
        "Epic account linked",
      );

      return reply.type("text/html").send(successHtml(user.epicDisplayName || displayName));
    } catch (err) {
      app.log.error({ err, testerId: pending.testerId }, "Epic OAuth callback failed");
      const raw = err instanceof Error ? err.message : "Authentication failed";
      // Don't rewrite every Supabase write error as "not configured" — that hid RLS failures.
      const message = /not configured on this PathGen server/i.test(raw)
        ? "Cloud user sync is offline. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Railway, then redeploy."
        : /already linked to another Zer0 account|duplicate|unique|epic_account_id/i.test(raw)
          ? "This Epic account is already linked to another Zer0 account. Disconnect it there first, then try again."
          : raw;
      return reply.type("text/html").code(500).send(errorHtml(message));
    }
  });

  app.delete("/api/epic/link", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user = await withTimeout(
      users.unlinkEpicAccount(tester.testerId, tester.inviteCode),
      8000,
      "epic unlink",
    );
    return { user };
  });

  app.get("/api/epic/status", async (request, reply) => {
    const tester = (request as AuthedRequest).tester;
    const configured = Boolean(epicConfigFrom(config));
    if (!users.enabled) {
      return {
        connected: false,
        epicAccountId: null,
        epicDisplayName: null,
        epicLinkedAt: null,
        configured,
      };
    }
    try {
      const user = await withTimeout(
        (async () =>
          (await users.getUser(tester.testerId)) ??
          (await users.ensureUser(tester.testerId, tester.inviteCode)))(),
        4000,
        "epic status",
      );
      return {
        connected: Boolean(user.epicAccountId),
        epicAccountId: user.epicAccountId ?? null,
        epicDisplayName: user.epicDisplayName ?? null,
        epicLinkedAt: user.epicLinkedAt ?? null,
        configured,
      };
    } catch (error) {
      app.log.warn({ err: error, testerId: tester.testerId }, "Epic status Supabase lookup failed");
      return {
        connected: false,
        epicAccountId: null,
        epicDisplayName: null,
        epicLinkedAt: null,
        configured,
      };
    }
  });
}
