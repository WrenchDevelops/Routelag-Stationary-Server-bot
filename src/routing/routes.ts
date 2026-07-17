import type { FastifyInstance, FastifyRequest } from "fastify";

import type { TokenClaims } from "../auth.js";
import type { CloudDataSync } from "../cloud/supabaseSync.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

export async function registerRoutingHistoryRoutes(
  app: FastifyInstance,
  cloud: CloudDataSync,
): Promise<void> {
  app.post<{
    Body: {
      sessionId?: string;
      clerkUserId?: string;
      nodeId?: string;
      gameId?: string;
      serverName?: string;
      endpoint?: string;
      appVersion?: string;
      active?: boolean;
      createdAt?: string;
      endedAt?: string | null;
      meta?: Record<string, unknown>;
    };
  }>("/api/routing/sessions", async (request, reply) => {
    if (!cloud.enabled) {
      return reply.code(503).send({ error: "Supabase is not configured", code: "supabase_unavailable" });
    }
    const tester = (request as AuthedRequest).tester;
    const body = request.body ?? {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const nodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is required" });
    }
    const createdAt =
      typeof body.createdAt === "string" && body.createdAt ? body.createdAt : new Date().toISOString();
    const active = body.active !== false;
    // Ending a session may omit node details — still require nodeId on create/start.
    if (active && !nodeId) {
      return reply.code(400).send({ error: "sessionId and nodeId are required to start a session" });
    }
    await cloud.upsertRoutingSession({
      sessionId,
      testerId: tester.testerId,
      clerkUserId: typeof body.clerkUserId === "string" ? body.clerkUserId : null,
      inviteCode: tester.inviteCode,
      nodeId: nodeId || "unknown",
      gameId: typeof body.gameId === "string" ? body.gameId : "fortnite",
      serverName: typeof body.serverName === "string" ? body.serverName : "",
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
      appVersion: typeof body.appVersion === "string" ? body.appVersion : "",
      active,
      createdAt,
      endedAt: body.endedAt ?? (active ? null : new Date().toISOString()),
      meta: body.meta && typeof body.meta === "object" ? body.meta : {},
    });
    return { ok: true };
  });
}
