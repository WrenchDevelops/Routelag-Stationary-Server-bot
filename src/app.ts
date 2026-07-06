import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { createToken, secureEquals, verifyToken, type TokenClaims } from "./auth.js";
import type { PathGenConfig } from "./config.js";
import { registerReplayRoutes } from "./replays/routes.js";
import { ReplayStore } from "./replays/replayStore.js";
import { OsirionClient } from "./replays/osirionClient.js";
import { syncPendingJobs } from "./replays/sync.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

export async function buildApp(config: PathGenConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const store = new ReplayStore(config.replayDataFile);
  const osirion = new OsirionClient(config);

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
  }));

  app.post<{ Body: { inviteCode?: string; code?: string; emailOrInvite?: string } }>(
    "/api/auth/login",
    async (request, reply) => handleInviteLogin(request, reply, config, app),
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
      );
    },
  );

  await registerReplayRoutes(app, config, store);

  const pollMs = Math.max(config.replayPollIntervalMs, 60_000);
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
) {
  const inviteCode = (request.body.inviteCode ?? request.body.emailOrInvite ?? "").trim();
  if (!config.inviteCodes.has(inviteCode)) {
    app.log.warn({ event: "pathgen_login_failure" }, "PathGen login failed");
    return reply.code(401).send({ error: "Invalid invite code" });
  }
  const auth = createToken(inviteCode, config.authSecret);
  app.log.info({ event: "pathgen_login_success", testerId: auth.testerId }, "PathGen login succeeded");
  return { token: auth.token, testerId: auth.testerId };
}
