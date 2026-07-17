import test from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createToken } from "../src/auth.js";
import { resetSupabaseForTests } from "../src/supabase.js";

test("user profile routes require auth and return 503 when Supabase is offline", async () => {
  resetSupabaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
  });
  const app = await buildApp(config);
  await app.ready();

  const denied = await app.inject({ method: "GET", url: "/api/users/me" });
  assert.equal(denied.statusCode, 401);

  const { token } = createToken("TEST-CODE", config.authSecret);
  const offline = await app.inject({
    method: "GET",
    url: "/api/users/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(offline.statusCode, 503);
  assert.equal(offline.json<{ code?: string }>().code, "supabase_unavailable");

  await app.close();
});
