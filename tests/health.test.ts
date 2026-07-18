import test from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("health reports minimal public pathgen status", async () => {
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
  });
  const app = await buildApp(config);
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json<Record<string, unknown>>();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pathgen");
  assert.equal(typeof body.version, "string");
  assert.ok(String(body.version).length > 0);
  // Must not leak infrastructure or privileged config.
  for (const key of [
    "supabaseUrl",
    "supabaseKeyRole",
    "supabaseConfigured",
    "osirionConfigured",
    "epicConfigured",
    "discordConfigured",
    "clerkConfigured",
    "allowInviteLogin",
    "requireClerkSubject",
    "gitSha",
    "buildAt",
  ]) {
    assert.equal(body[key], undefined, `health must not expose ${key}`);
  }
  await app.close();
});
