import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { createToken, secureEquals, verifyToken, type TokenClaims } from "./auth.js";
import type { PathGenConfig } from "./config.js";
import { initFirebase } from "./firebase.js";
import { registerReplayRoutes } from "./replays/routes.js";
import { ReplayStore } from "./replays/replayStore.js";
import { OsirionClient } from "./replays/osirionClient.js";
import { syncPendingJobs } from "./replays/sync.js";
import { registerUserRoutes } from "./users/routes.js";
import { UserStore } from "./users/userStore.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

export async function buildApp(config: PathGenConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const store = new ReplayStore(config.replayDataFile);
  const osirion = new OsirionClient(config);
  const firebase = initFirebase({
    projectId: config.firebaseProjectId,
    credentialsPath: config.firebaseCredentialsPath,
    credentialsJson: config.firebaseCredentialsJson,
    disabled: config.firebaseDisabled,
  });
  const users = new UserStore(firebase);

  if (firebase.enabled) {
    app.log.info({ projectId: firebase.projectId }, "Firebase Admin initialized");
  } else {
    app.log.warn("Firebase Admin is disabled or not configured; cloud user sync is offline");
  }

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.decorateRequest("tester", null);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/api/auth")) {
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
    (request as AuthedRequest).tester = tester;
  });

  app.get("/health", async () => ({
    ok: true,
    service: "routelag-stationary-server",
    osirionConfigured: Boolean(config.osirionApiKey),
    firebaseConfigured: users.enabled,
    firebaseProjectId: firebase.projectId,
    // Railway injects these; useful to confirm which git SHA is live.
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA_SHORT ?? null,
    buildAt: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
  }));

  app.post<{ Body: { inviteCode?: string; code?: string; emailOrInvite?: string } }>(
    "/api/auth/login",
    async (request, reply) => handleInviteLogin(request, reply, config, app, users, store),
  );

  app.post<{ Body: { code?: string; inviteCode?: string; emailOrInvite?: string } }>(
    "/api/beta/login",
    async (request, reply) => {
      const inviteCode = (
        request.body.code ??
        request.body.inviteCode ??
        request.body.emailOrInvite ??
        ""
      ).trim();
      return handleInviteLogin(
        { ...request, body: { inviteCode } } as typeof request,
        reply,
        config,
        app,
        users,
        store,
      );
    },
  );

  await registerReplayRoutes(app, config, store);
  await registerUserRoutes(app, users);

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

async function handleInviteLogin(
  request: FastifyRequest<{ Body: { inviteCode?: string; emailOrInvite?: string } }>,
  reply: FastifyReply,
  config: PathGenConfig,
  app: FastifyInstance,
  users?: UserStore,
  store?: ReplayStore,
) {
  const inviteCode = (request.body.inviteCode ?? request.body.emailOrInvite ?? "").trim();
  if (!isInviteAllowed(inviteCode, config.inviteCodes)) {
    app.log.warn({ event: "pathgen_login_failure" }, "PathGen login failed");
    return reply.code(401).send({ error: "Invalid invite code" });
  }
  const canonicalInvite = resolveInviteCode(inviteCode, config.inviteCodes);
  const auth = createToken(canonicalInvite, config.authSecret);
  if (store) {
    const moved = store.migrateInviteOwnership(canonicalInvite, auth.testerId);
    if (moved > 0) {
      app.log.info(
        { event: "pathgen_identity_migrated", testerId: auth.testerId, moved },
        "Migrated legacy replay ownership to stable tester id",
      );
    }
    store.repairReplaySummaries(auth.testerId);
  }
  if (users?.enabled) {
    void users.touchLogin(auth.testerId, canonicalInvite);
  }
  app.log.info({ event: "pathgen_login_success", testerId: auth.testerId }, "PathGen login succeeded");
  return { token: auth.token, testerId: auth.testerId };
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
  if (inviteCodes.has(inviteCode)) return inviteCode;
  const lower = inviteCode.toLowerCase();
  for (const code of inviteCodes) {
    if (code.toLowerCase() === lower) return code;
  }
  return inviteCode;
}
