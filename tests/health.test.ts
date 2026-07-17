import test from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("health reports pathgen service", async () => {
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    firebaseDisabled: true,
  });
  const app = await buildApp(config);
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json<{
    ok: boolean;
    service: string;
    firebaseConfigured: boolean;
  }>();
  assert.equal(body.ok, true);
  assert.equal(body.service, "routelag-stationary-server");
  assert.equal(body.firebaseConfigured, false);
  await app.close();
});
