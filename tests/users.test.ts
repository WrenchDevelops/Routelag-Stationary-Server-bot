import test from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createToken } from "../src/auth.js";
import { resetFirebaseForTests } from "../src/firebase.js";

test("user profile routes require auth and work with Firebase", async () => {
  resetFirebaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    firebaseProjectId: "lunory-61a2a",
    firebaseCredentialsPath: "secrets/firebase-adminsdk.json",
    firebaseDisabled: false,
  });
  const app = await buildApp(config);
  await app.ready();

  const denied = await app.inject({ method: "GET", url: "/api/users/me" });
  assert.equal(denied.statusCode, 401);

  const { token, testerId } = createToken("TEST-CODE", config.authSecret);
  const profileResponse = await app.inject({
    method: "PUT",
    url: "/api/users/me/profile",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      profile: {
        tester_name: "Firebase Tester",
        discord_username: "firebase#0001",
        fortnite_region: "Middle East",
      },
    },
  });
  assert.equal(profileResponse.statusCode, 200);
  const saved = profileResponse.json<{
    user: { testerId: string; profile: { tester_name: string } };
  }>();
  assert.equal(saved.user.testerId, testerId);
  assert.equal(saved.user.profile.tester_name, "Firebase Tester");

  const me = await app.inject({
    method: "GET",
    url: "/api/users/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json<{ user: { profile: { tester_name: string } } }>().user.profile.tester_name, "Firebase Tester");

  await app.close();
});
