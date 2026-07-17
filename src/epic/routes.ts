import type { FastifyInstance, FastifyRequest } from "fastify";

import type { TokenClaims } from "../auth.js";
import type { PathGenConfig } from "../config.js";
import type { UserStore } from "../users/userStore.js";
import {
  buildEpicAuthorizeUrl,
  consumeEpicLinkState,
  createEpicLinkState,
  exchangeEpicAuthorizationCode,
  fetchEpicUserInfo,
  fingerprintClientId,
  resolveEpicDisplayName,
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

function firebaseUnavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(503).send({
    error: "Firebase is not configured on this PathGen server.",
    code: "firebase_unavailable",
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
    if (!users.enabled) return firebaseUnavailable(reply);

    const tester = (request as AuthedRequest).tester;
    const state = createEpicLinkState(tester.testerId, tester.inviteCode);
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
    if (!users.enabled) {
      return reply.type("text/html").code(503).send(errorHtml("Cloud user sync is offline."));
    }

    const { code, state, error, error_description } = request.query;
    if (error) {
      const detail = error_description || error;
      return reply.type("text/html").code(400).send(errorHtml(`Epic denied access: ${detail}`));
    }
    if (!code || !state) {
      return reply.type("text/html").code(400).send(errorHtml("Missing authorization code or state."));
    }

    const pending = consumeEpicLinkState(state);
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

      const user = await users.linkEpicAccount(pending.testerId, pending.inviteCode, {
        epicAccountId: accountId,
        epicDisplayName: displayName,
      });

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
      const message = err instanceof Error ? err.message : "Authentication failed";
      return reply.type("text/html").code(500).send(errorHtml(message));
    }
  });

  app.delete("/api/epic/link", async (request, reply) => {
    if (!users.enabled) return firebaseUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user = await users.unlinkEpicAccount(tester.testerId, tester.inviteCode);
    return { user };
  });

  app.get("/api/epic/status", async (request, reply) => {
    if (!users.enabled) return firebaseUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user =
      (await users.getUser(tester.testerId)) ??
      (await users.ensureUser(tester.testerId, tester.inviteCode));
    return {
      connected: Boolean(user.epicAccountId),
      epicAccountId: user.epicAccountId ?? null,
      epicDisplayName: user.epicDisplayName ?? null,
      epicLinkedAt: user.epicLinkedAt ?? null,
      configured: Boolean(epicConfigFrom(config)),
    };
  });
}
