import type { FastifyInstance, FastifyRequest } from "fastify";

import type { TokenClaims } from "../auth.js";
import type { UserStore } from "./userStore.js";
import type { CloudAppPreferences, CloudConnections, CloudTesterProfile } from "./types.js";

interface AuthedRequest extends FastifyRequest {
  tester: TokenClaims;
}

function cloudUnavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(503).send({
    error: "Supabase is not configured on this PathGen server.",
    code: "supabase_unavailable",
  });
}

export async function registerUserRoutes(app: FastifyInstance, users: UserStore): Promise<void> {
  app.get("/api/users/me", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user = (await users.getUser(tester.testerId)) ?? (await users.ensureUser(tester.testerId, tester.inviteCode));
    return { user };
  });

  app.put<{
    Body: {
      clerkUserId?: string;
      clerkEmail?: string;
      connections?: CloudConnections;
      billingSnapshot?: Record<string, unknown>;
    };
  }>("/api/users/me/identity", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const body = request.body ?? {};
    // Identity is taken from the verified PathGen token only — ignore body spoof fields.
    const user = await users.upsertIdentity(tester.testerId, tester.inviteCode, {
      clerkUserId: tester.clerkUserId,
      connections: body.connections,
      billingSnapshot: body.billingSnapshot,
    });
    return { user };
  });

  app.put<{ Body: { profile?: Partial<CloudTesterProfile> } }>("/api/users/me/profile", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const profile = request.body?.profile;
    if (!profile || typeof profile !== "object") {
      return reply.code(400).send({ error: "profile object is required" });
    }
    const user = await users.upsertProfile(tester.testerId, tester.inviteCode, profile);
    return { user };
  });

  app.put<{ Body: { preferences?: Partial<CloudAppPreferences> } }>(
    "/api/users/me/preferences",
    async (request, reply) => {
      if (!users.enabled) return cloudUnavailable(reply);
      const tester = (request as AuthedRequest).tester;
      const preferences = request.body?.preferences;
      if (!preferences || typeof preferences !== "object") {
        return reply.code(400).send({ error: "preferences object is required" });
      }
      const user = await users.upsertPreferences(tester.testerId, tester.inviteCode, preferences);
      return { user };
    },
  );

  app.get("/api/users/me/preferences", async (request, reply) => {
    if (!users.enabled) return cloudUnavailable(reply);
    const tester = (request as AuthedRequest).tester;
    const user = (await users.getUser(tester.testerId)) ?? (await users.ensureUser(tester.testerId, tester.inviteCode));
    return { preferences: user.preferences };
  });
}
