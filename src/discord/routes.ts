import type { FastifyInstance, FastifyRequest } from "fastify";

import type { TokenClaims } from "../auth.js";
import type { PathGenConfig } from "../config.js";
import { withTimeout } from "../epic/oauth.js";
import type { UserStore } from "../users/userStore.js";
import {
  buildDiscordAuthorizeUrl,
  consumeMemoryDiscordLinkState,
  createDiscordLinkStateValue,
  discordLinkExpiresAt,
  exchangeDiscordAuthorizationCode,
  fetchDiscordUserInfo,
  fingerprintClientId,
  rememberDiscordLinkState,
  resolveDiscordDisplayName,
  type DiscordOAuthConfig,
} from "./oauth.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

function discordConfigFrom(config: PathGenConfig): DiscordOAuthConfig | null {
  if (!config.discordClientId || !config.discordClientSecret || !config.discordRedirectUri) {
    return null;
  }
  return {
    clientId: config.discordClientId,
    clientSecret: config.discordClientSecret,
    redirectUri: config.discordRedirectUri,
  };
}

function discordUnavailable(reply: {
  code: (status: number) => { send: (body: unknown) => unknown };
}) {
  return reply.code(503).send({
    error: "Discord OAuth is not configured on this PathGen server.",
    code: "discord_unavailable",
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
  <title>Discord linked</title>
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
    <h1>Discord connected</h1>
    <p>Linked as <strong>${safe}</strong>. You can close this window and return to Zer0.</p>
  </main>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "DISCORD_AUTH_SUCCESS", displayName: ${JSON.stringify(displayName)} }, "*");
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
  <title>Discord link failed</title>
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
    <h1>Could not link Discord</h1>
    <p>${safe}</p>
  </main>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "DISCORD_AUTH_ERROR", message: ${JSON.stringify(message)} }, "*");
      }
    } catch (_) {}
  </script>
</body>
</html>`;
}

export async function registerDiscordRoutes(
  app: FastifyInstance,
  config: PathGenConfig,
  users: UserStore,
): Promise<void> {
  app.get("/api/discord/start", async (request, reply) => {
    const discord = discordConfigFrom(config);
    if (!discord) return discordUnavailable(reply);

    const tester = (request as AuthedRequest).tester;
    const state = createDiscordLinkStateValue();
    const expiresAt = discordLinkExpiresAt();

    rememberDiscordLinkState(state, tester.testerId, tester.inviteCode, expiresAt);

    if (users.enabled) {
      try {
        await withTimeout(
          users.saveDiscordOAuthState(state, {
            testerId: tester.testerId,
            inviteCode: tester.inviteCode,
            expiresAt,
          }),
          2500,
          "discord oauth state persist",
        );
      } catch (error) {
        app.log.warn({ err: error, testerId: tester.testerId }, "Discord OAuth Supabase persist skipped");
      }
    }

    const url = buildDiscordAuthorizeUrl(discord, state);
    app.log.info(
      {
        event: "discord_oauth_start",
        testerId: tester.testerId,
        clientFingerprint: fingerprintClientId(discord.clientId),
      },
      "Discord OAuth start",
    );

    return { url, state };
  });

  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>("/api/discord/callback", async (request, reply) => {
    const discord = discordConfigFrom(config);
    if (!discord) {
      return reply.type("text/html").code(503).send(errorHtml("Discord OAuth is not configured."));
    }

    const { code, state, error, error_description } = request.query;
    if (error) {
      const detail = error_description || error;
      return reply.type("text/html").code(400).send(errorHtml(`Discord denied access: ${detail}`));
    }
    if (!code || !state) {
      return reply.type("text/html").code(400).send(errorHtml("Missing authorization code or state."));
    }

    let pending =
      consumeMemoryDiscordLinkState(state) ??
      (users.enabled
        ? await withTimeout(users.consumeDiscordOAuthState(state), 4000, "discord oauth state lookup").catch(
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
      const token = await exchangeDiscordAuthorizationCode(discord, code);
      if (!token.access_token) throw new Error("Discord token response missing access_token");

      const userInfo = await fetchDiscordUserInfo(token.access_token);
      const displayName = resolveDiscordDisplayName(userInfo);

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
        users.linkDiscordAccount(pending.testerId, pending.inviteCode, {
          discordUserId: userInfo.id,
          discordUsername: displayName,
        }),
        8000,
        "discord account link",
      );

      app.log.info(
        {
          event: "discord_oauth_linked",
          testerId: pending.testerId,
          discordUserId: user.discordUserId,
        },
        "Discord account linked",
      );

      return reply.type("text/html").send(successHtml(user.discordUsername || displayName));
    } catch (err) {
      app.log.error({ err, testerId: pending.testerId }, "Discord OAuth callback failed");
      const raw = err instanceof Error ? err.message : "Authentication failed";
      const message = /not configured on this PathGen server/i.test(raw)
        ? "Cloud user sync is offline. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Railway, then redeploy."
        : /already linked to another Zer0 account|duplicate|unique|pathgen_users_discord_user_id/i.test(
              raw,
            )
          ? "This Discord account is already linked to another Zer0 account. Disconnect it there first, then try again."
          : raw;
      return reply.type("text/html").code(500).send(errorHtml(message));
    }
  });

  app.delete("/api/discord/link", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user = await withTimeout(
      users.unlinkDiscordAccount(tester.testerId, tester.inviteCode),
      8000,
      "discord unlink",
    );
    return { user };
  });

  app.get("/api/discord/status", async (request, reply) => {
    const tester = (request as AuthedRequest).tester;
    const configured = Boolean(discordConfigFrom(config));
    if (!users.enabled) {
      return {
        connected: false,
        discordUserId: null,
        discordUsername: null,
        discordLinkedAt: null,
        configured,
      };
    }
    try {
      const user = await withTimeout(
        (async () =>
          (await users.getUser(tester.testerId)) ??
          (await users.ensureUser(tester.testerId, tester.inviteCode)))(),
        4000,
        "discord status",
      );
      return {
        connected: Boolean(user.discordUserId),
        discordUserId: user.discordUserId ?? null,
        discordUsername: user.discordUsername ?? null,
        discordLinkedAt: user.discordLinkedAt ?? null,
        configured,
      };
    } catch (error) {
      app.log.warn({ err: error, testerId: tester.testerId }, "Discord status Supabase lookup failed");
      return {
        connected: false,
        discordUserId: null,
        discordUsername: null,
        discordLinkedAt: null,
        configured,
      };
    }
  });
}
