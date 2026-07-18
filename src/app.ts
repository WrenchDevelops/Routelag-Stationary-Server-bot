import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { createToken, secureEquals, verifyToken, type TokenClaims } from "./auth.js";
import {
  createClerkSessionVerifier,
  type ClerkIdentity,
  type ClerkSessionVerifier,
} from "./clerkAuth.js";
import type { PathGenConfig } from "./config.js";
import { initSupabase } from "./supabase.js";
import { CloudDataSync } from "./cloud/supabaseSync.js";
import { registerReplayRoutes } from "./replays/routes.js";
import { ReplayStore } from "./replays/replayStore.js";
import { OsirionClient } from "./replays/osirionClient.js";
import { syncPendingJobs } from "./replays/sync.js";
import { registerEpicRoutes } from "./epic/routes.js";
import { registerDiscordRoutes } from "./discord/routes.js";
import { registerRoutingHistoryRoutes } from "./routing/routes.js";
import { registerUserRoutes } from "./users/routes.js";
import { UserStore } from "./users/userStore.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

export async function buildApp(config: PathGenConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const store = new ReplayStore(config.replayDataFile);
  const osirion = new OsirionClient(config);
  const supabase = initSupabase({
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    disabled: config.supabaseDisabled,
  });
  const users = new UserStore(supabase);
  const cloud = new CloudDataSync(supabase.client);
  store.setCloudSync(cloud);

  const clerkVerifier = resolveClerkVerifier(config);

  if (supabase.enabled) {
    app.log.info({ url: supabase.url }, "Supabase client initialized");
  } else {
    app.log.warn("Supabase is disabled or not configured; cloud user sync is offline");
  }

  if (config.isProduction && !clerkVerifier) {
    app.log.error(
      "Clerk JWKS verification is not configured — PathGen login will fail closed in production",
    );
  }

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.decorateRequest("tester", null);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/api/auth")) {
      return;
    }
    // OAuth browser callbacks (no PathGen JWT yet — state ties the link).
    if (
      request.url.startsWith("/api/epic/callback") ||
      request.url.startsWith("/api/discord/callback")
    ) {
      return;
    }
    if (request.url.startsWith("/api/replays/osirion/webhook")) {
      return;
    }
    if (!request.url.startsWith("/api/")) {
      return;
    }

    const serviceKey = config.serviceApiKey;
    const serviceHeader = String(request.headers["x-pathgen-api-key"] ?? "");
    if (serviceKey && serviceHeader && secureEquals(serviceHeader, serviceKey)) {
      (request as AuthedRequest).tester = {
        testerId: "service_bot",
        inviteCode: "service",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      return;
    }

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const tester = token ? verifyToken(token, config.authSecret) : null;
    if (!tester) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (config.requireClerkSubject && tester.testerId !== "service_bot" && !tester.clerkUserId) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    store.rememberClerkIdentity(tester.testerId, tester.clerkUserId);
    (request as AuthedRequest).tester = tester;
  });

  // Public health: minimal status only — no Supabase/Clerk/secret/config leakage.
  app.get("/health", async () => ({
    ok: true,
    service: "pathgen",
    version: resolvePublicVersion(),
  }));

  app.post<{
    Body: {
      inviteCode?: string;
      code?: string;
      emailOrInvite?: string;
      clerkUserId?: string;
      clerkSessionToken?: string;
      clerkToken?: string;
    };
  }>("/api/auth/login", async (request, reply) =>
    handleLogin(request, reply, config, app, clerkVerifier, users, store, cloud),
  );

  app.post<{
    Body: {
      code?: string;
      inviteCode?: string;
      emailOrInvite?: string;
      clerkUserId?: string;
      clerkSessionToken?: string;
      clerkToken?: string;
    };
  }>("/api/beta/login", async (request, reply) => {
    const inviteCode = (
      request.body.code ??
      request.body.inviteCode ??
      request.body.emailOrInvite ??
      ""
    ).trim();
    return handleLogin(
      {
        ...request,
        body: {
          inviteCode,
          clerkSessionToken: request.body.clerkSessionToken ?? request.body.clerkToken,
          // Intentionally drop body clerkUserId — identity must come from verified Clerk JWT.
        },
      } as typeof request,
      reply,
      config,
      app,
      clerkVerifier,
      users,
      store,
      cloud,
    );
  });

  await registerReplayRoutes(app, config, store);
  await registerUserRoutes(app, users);
  await registerEpicRoutes(app, config, users);
  await registerDiscordRoutes(app, config, users);
  await registerRoutingHistoryRoutes(app, cloud);

  const pollMs = Math.max(config.replayPollIntervalMs, 15_000);
  const pollTimer = setInterval(() => {
    void syncPendingJobs(store, osirion, config).catch((error) => {
      app.log.warn({ err: error }, "Replay poll cycle failed");
    });
  }, pollMs);
  pollTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(pollTimer);
  });

  return app;
}

function resolveClerkVerifier(config: PathGenConfig): ClerkSessionVerifier | null {
  if (config.clerkSessionVerifier) return config.clerkSessionVerifier;
  if (!config.clerkIssuer || !config.clerkJwksUrl) return null;
  return createClerkSessionVerifier({
    issuer: config.clerkIssuer,
    jwksUrl: config.clerkJwksUrl,
    audiences: config.clerkAudiences,
    authorizedParties: config.clerkAuthorizedParties,
  });
}

async function handleLogin(
  request: FastifyRequest<{
    Body: {
      inviteCode?: string;
      emailOrInvite?: string;
      clerkUserId?: string;
      clerkSessionToken?: string;
      clerkToken?: string;
    };
  }>,
  reply: FastifyReply,
  config: PathGenConfig,
  app: FastifyInstance,
  clerkVerifier: ClerkSessionVerifier | null,
  users?: UserStore,
  store?: ReplayStore,
  cloud?: CloudDataSync,
) {
  // Body-supplied clerkUserId / email are never trusted as identity.
  const bodyClerkUserId =
    typeof request.body.clerkUserId === "string" ? request.body.clerkUserId.trim() : "";
  if (bodyClerkUserId) {
    app.log.warn(
      { event: "pathgen_login_spoof_attempt" },
      "Ignored client-supplied clerkUserId on PathGen login",
    );
  }

  const inviteCode = (request.body.inviteCode ?? request.body.emailOrInvite ?? "").trim();
  const clerkSessionToken = extractClerkSessionToken(request);

  let clerkIdentity: ClerkIdentity | null = null;
  if (clerkSessionToken) {
    if (!clerkVerifier) {
      app.log.error({ event: "pathgen_login_clerk_unconfigured" }, "Clerk verification unavailable");
      return reply.code(401).send({ error: "Unauthorized" });
    }
    clerkIdentity = await clerkVerifier(clerkSessionToken);
    if (!clerkIdentity) {
      app.log.warn({ event: "pathgen_login_failure" }, "PathGen Clerk token verification failed");
      return reply.code(401).send({ error: "Unauthorized" });
    }
  }

  if (!clerkIdentity) {
    if (!config.allowInviteLogin) {
      app.log.warn({ event: "pathgen_login_failure" }, "PathGen login missing Clerk session");
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (!isInviteAllowed(inviteCode, config.inviteCodes)) {
      app.log.warn({ event: "pathgen_login_failure" }, "PathGen invite login failed");
      return reply.code(401).send({ error: "Unauthorized" });
    }
  }

  // Body invite/email is never identity. Only an allowlisted invite may be stored
  // on the PathGen token (for legacy migration). Otherwise use the Clerk sentinel.
  const canonicalInvite = clerkIdentity
    ? inviteCode && isInviteAllowed(inviteCode, config.inviteCodes)
      ? resolveInviteCode(inviteCode, config.inviteCodes)
      : "clerk"
    : resolveInviteCode(inviteCode, config.inviteCodes);

  const auth = createToken(canonicalInvite, config.authSecret, {
    clerkUserId: clerkIdentity?.clerkUserId,
    ttlSec: config.pathgenTokenTtlSec,
  });
  store?.rememberClerkIdentity(auth.testerId, clerkIdentity?.clerkUserId);

  // Create/update the canonical Supabase user row first so connected-account
  // merges and later OAuth links always have a destination row to write to.
  if (users?.enabled) {
    try {
      await users.ensureUser(auth.testerId, canonicalInvite, {
        clerkUserId: clerkIdentity?.clerkUserId,
        // Email only from verified Clerk claims — never from the request body.
        clerkEmail: clerkIdentity?.email,
      });
    } catch (error) {
      app.log.warn({ err: error, testerId: auth.testerId }, "Supabase ensureUser on login failed");
    }
  }

  // Safe migration: invite-code ownership only (allowlisted shared secret).
  // Never merge accounts based solely on an unverified client-provided email.
  if (users?.enabled && clerkIdentity && inviteCode && isInviteAllowed(inviteCode, config.inviteCodes)) {
    try {
      const legacy = await users.getUserByInviteCodeExact(inviteCode);
      if (legacy && legacy.testerId !== auth.testerId) {
        if (legacy.clerkUserId && legacy.clerkUserId !== clerkIdentity.clerkUserId) {
          app.log.warn(
            {
              event: "pathgen_identity_merge_blocked",
              fromTesterId: legacy.testerId,
              toTesterId: auth.testerId,
            },
            "Invite-linked account already bound to a different Clerk user — manual review required",
          );
        } else {
          const movedCloud =
            (await cloud?.migrateTesterOwnership(
              legacy.testerId,
              auth.testerId,
              clerkIdentity.clerkUserId,
            )) ?? 0;
          store?.migrateInviteOwnership(canonicalInvite === "clerk" ? inviteCode : canonicalInvite, auth.testerId);
          await users.mergeLinkedAccounts(legacy.testerId, auth.testerId);
          app.log.info(
            {
              event: "pathgen_identity_merged",
              fromTesterId: legacy.testerId,
              toTesterId: auth.testerId,
              movedCloud,
            },
            "Merged invite-linked PathGen account onto verified Clerk tester id",
          );
        }
      }
    } catch (error) {
      app.log.warn({ err: error, testerId: auth.testerId }, "Legacy identity merge failed");
    }
  }

  if (store) {
    if (inviteCode && isInviteAllowed(inviteCode, config.inviteCodes)) {
      const moved = store.migrateInviteOwnership(
        resolveInviteCode(inviteCode, config.inviteCodes),
        auth.testerId,
      );
      if (moved > 0) {
        app.log.info(
          { event: "pathgen_identity_migrated", testerId: auth.testerId, moved },
          "Migrated legacy replay ownership to stable tester id",
        );
      }
    }
    await store.hydrateFromCloud(auth.testerId, clerkIdentity?.clerkUserId);
    store.repairReplaySummaries(auth.testerId);
  }
  app.log.info(
    {
      event: "pathgen_login_success",
      testerId: auth.testerId,
      hasClerkId: Boolean(clerkIdentity?.clerkUserId),
      inviteLogin: !clerkIdentity,
    },
    "PathGen login succeeded",
  );
  return { token: auth.token, testerId: auth.testerId };
}

function extractClerkSessionToken(
  request: FastifyRequest<{
    Body: { clerkSessionToken?: string; clerkToken?: string };
  }>,
): string {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const bearer = header.slice("Bearer ".length).trim();
    // PathGen mint tokens are HS256 with our secret; Clerk session tokens are also JWTs.
    // Login accepts Bearer as the Clerk session token (desktop sends getToken()).
    if (bearer) return bearer;
  }
  const fromBody =
    (typeof request.body.clerkSessionToken === "string" && request.body.clerkSessionToken) ||
    (typeof request.body.clerkToken === "string" && request.body.clerkToken) ||
    "";
  return fromBody.trim();
}

function isInviteAllowed(inviteCode: string, inviteCodes: Set<string>): boolean {
  if (!inviteCode) return false;
  if (inviteCodes.has(inviteCode)) return true;
  const lower = inviteCode.toLowerCase();
  for (const code of inviteCodes) {
    if (code.toLowerCase() === lower) return true;
  }
  return false;
}

function resolveInviteCode(inviteCode: string, inviteCodes: Set<string>): string {
  if (!inviteCode) return "";
  if (inviteCodes.has(inviteCode)) return inviteCode;
  const lower = inviteCode.toLowerCase();
  for (const code of inviteCodes) {
    if (code.toLowerCase() === lower) return code;
  }
  return inviteCode;
}

/** Safe public build label — package version plus optional short commit, never secrets. */
function resolvePublicVersion(): string {
  const pkgVersion = process.env.npm_package_version?.trim() || "0.1.0";
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA_SHORT?.trim() ||
    "";
  if (sha) return `${pkgVersion}+${sha.slice(0, 7)}`;
  return pkgVersion;
}
