import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, SignJWT, exportJWK, type KeyLike } from "jose";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createToken, stableClerkTesterId, verifyToken } from "../src/auth.js";
import { createClerkSessionVerifier } from "../src/clerkAuth.js";
import { ReplayStore } from "../src/replays/replayStore.js";
import { resetSupabaseForTests } from "../src/supabase.js";
import type { PathGenReplayDetail } from "../src/replays/types.js";

const ISSUER = "https://clerk.test.example";
const AUDIENCE = "zer0-desktop";
const AZP = "pk_test_zer0";

async function makeClerkKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, publicKey, jwk };
}

async function signClerkToken(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  options?: { expOffsetSec?: number; audience?: string | string[]; issuer?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expOffset = options?.expOffsetSec ?? 600;
  let builder = new SignJWT({ azp: AZP, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt(now)
    .setExpirationTime(now + expOffset)
    .setIssuer(options?.issuer ?? ISSUER)
    .setSubject(String(claims.sub ?? "user_attacker"));
  if (options?.audience) builder = builder.setAudience(options.audience);
  return builder.sign(privateKey);
}

function testDataFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pathgen-auth-"));
  return join(dir, "db.json");
}

function seedReplay(dataFile: string, userId: string, replayId: string): void {
  const store = new ReplayStore(dataFile);
  const job = store.createJob({
    userId,
    inviteCode: "TEST-CODE",
    fileName: "victim.replay",
    fileHash: `hash-${replayId}`,
    fileSizeBytes: 12,
    status: "parsed",
    provider: "osirion",
  });
  const detail: PathGenReplayDetail = {
    summary: {
      id: replayId,
      userId,
      jobId: job.id,
      fileName: "victim.replay",
      fileHash: `hash-${replayId}`,
      status: "parsed",
      parseTier: "basic",
      deepParseStatus: "available",
      createdAt: new Date().toISOString(),
    },
    player: {},
    keyMoments: [],
  };
  store.saveReplay(detail);
}

test("valid Clerk token authenticates the correct user; spoofed body clerkUserId ignored", async () => {
  resetSupabaseForTests();
  const { privateKey, publicKey } = await makeClerkKeys();
  const verifier = createClerkSessionVerifier({
    issuer: ISSUER,
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    audiences: [AUDIENCE],
    authorizedParties: [AZP],
    localKey: publicKey,
  });
  const dataFile = testDataFile();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: false,
    allowInviteLogin: false,
    requireClerkSubject: true,
    clerkIssuer: ISSUER,
    clerkJwksUrl: `${ISSUER}/.well-known/jwks.json`,
    clerkAudiences: [AUDIENCE],
    clerkAuthorizedParties: [AZP],
    clerkSessionVerifier: verifier,
    replayDataFile: dataFile,
  });
  const app = await buildApp(config);
  await app.ready();

  const clerkJwt = await signClerkToken(
    privateKey,
    { sub: "user_real_alice" },
    { audience: AUDIENCE },
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { authorization: `Bearer ${clerkJwt}` },
    payload: {
      clerkUserId: "user_victim_should_ignore",
      emailOrInvite: "victim@example.com",
    },
  });
  assert.equal(login.statusCode, 200);
  const body = login.json<{ token: string; testerId: string }>();
  assert.equal(body.testerId, stableClerkTesterId("user_real_alice"));
  assert.notEqual(body.testerId, stableClerkTesterId("user_victim_should_ignore"));

  const claims = verifyToken(body.token, config.authSecret);
  assert.ok(claims);
  assert.equal(claims.clerkUserId, "user_real_alice");

  await app.close();
});

test("missing / invalid / expired / wrong-issuer / wrong-audience Clerk tokens return 401", async () => {
  resetSupabaseForTests();
  const { privateKey, publicKey } = await makeClerkKeys();
  const other = await generateKeyPair("RS256");
  const verifier = createClerkSessionVerifier({
    issuer: ISSUER,
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    audiences: [AUDIENCE],
    authorizedParties: [AZP],
    localKey: publicKey,
  });
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: true,
    allowInviteLogin: false,
    requireClerkSubject: true,
    clerkIssuer: ISSUER,
    clerkJwksUrl: `${ISSUER}/.well-known/jwks.json`,
    clerkAudiences: [AUDIENCE],
    clerkAuthorizedParties: [AZP],
    clerkSessionVerifier: verifier,
    replayDataFile: testDataFile(),
  });
  const app = await buildApp(config);
  await app.ready();

  const missing = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { clerkUserId: "user_anyone" },
  });
  assert.equal(missing.statusCode, 401);

  const badSig = await signClerkToken(other.privateKey, { sub: "user_alice" }, { audience: AUDIENCE });
  const invalidSig = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { authorization: `Bearer ${badSig}` },
    payload: {},
  });
  assert.equal(invalidSig.statusCode, 401);

  const expired = await signClerkToken(
    privateKey,
    { sub: "user_alice" },
    { audience: AUDIENCE, expOffsetSec: -30 },
  );
  const expiredRes = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { authorization: `Bearer ${expired}` },
    payload: {},
  });
  assert.equal(expiredRes.statusCode, 401);

  const wrongIss = await signClerkToken(
    privateKey,
    { sub: "user_alice" },
    { audience: AUDIENCE, issuer: "https://evil.example" },
  );
  const wrongIssRes = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { authorization: `Bearer ${wrongIss}` },
    payload: {},
  });
  assert.equal(wrongIssRes.statusCode, 401);

  const wrongAud = await signClerkToken(
    privateKey,
    { sub: "user_alice" },
    { audience: "other-app" },
  );
  const wrongAudRes = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { authorization: `Bearer ${wrongAud}` },
    payload: {},
  });
  assert.equal(wrongAudRes.statusCode, 401);

  await app.close();
});

test("spoofed clerkUserId / email cannot mint another user identity", async () => {
  resetSupabaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: true,
    allowInviteLogin: false,
    requireClerkSubject: true,
    clerkIssuer: ISSUER,
    clerkJwksUrl: `${ISSUER}/.well-known/jwks.json`,
    clerkSessionVerifier: async () => null,
    replayDataFile: testDataFile(),
  });
  const app = await buildApp(config);
  await app.ready();

  const spoofUser = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { clerkUserId: "user_victim" },
  });
  assert.equal(spoofUser.statusCode, 401);

  const spoofEmail = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { inviteCode: "victim@example.com", emailOrInvite: "victim@example.com" },
  });
  assert.equal(spoofEmail.statusCode, 401);

  await app.close();
});

test("users cannot list/read/delete another user's replays", async () => {
  resetSupabaseForTests();
  const dataFile = testDataFile();
  const victimId = stableClerkTesterId("user_victim");
  const attackerId = stableClerkTesterId("user_attacker");
  seedReplay(dataFile, victimId, "replay_victim_1");

  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: false,
    allowInviteLogin: false,
    requireClerkSubject: true,
    replayDataFile: dataFile,
  });
  const app = await buildApp(config);
  await app.ready();

  const { token: attackerToken } = createToken("clerk", config.authSecret, {
    clerkUserId: "user_attacker",
  });
  assert.equal(stableClerkTesterId("user_attacker"), attackerId);

  const list = await app.inject({
    method: "GET",
    url: "/api/replays",
    headers: { authorization: `Bearer ${attackerToken}` },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json<{ replays: unknown[] }>().replays, []);

  const read = await app.inject({
    method: "GET",
    url: "/api/replays/replay_victim_1",
    headers: { authorization: `Bearer ${attackerToken}` },
  });
  assert.equal(read.statusCode, 404);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/replays/replay_victim_1",
    headers: { authorization: `Bearer ${attackerToken}` },
  });
  assert.equal(del.statusCode, 404);

  // Victim can still see their replay.
  const { token: victimToken } = createToken("clerk", config.authSecret, {
    clerkUserId: "user_victim",
  });
  const victimRead = await app.inject({
    method: "GET",
    url: "/api/replays/replay_victim_1",
    headers: { authorization: `Bearer ${victimToken}` },
  });
  assert.equal(victimRead.statusCode, 200);

  const victimDelete = await app.inject({
    method: "DELETE",
    url: "/api/replays/replay_victim_1",
    headers: { authorization: `Bearer ${victimToken}` },
  });
  assert.equal(victimDelete.statusCode, 200);

  await app.close();
});

test("identity and profile updates cannot override another user's clerk subject via body", async () => {
  resetSupabaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: false,
    allowInviteLogin: true,
    requireClerkSubject: true,
    replayDataFile: testDataFile(),
  });
  const app = await buildApp(config);
  await app.ready();

  const { token } = createToken("TEST-CODE", config.authSecret, {
    clerkUserId: "user_attacker",
  });

  const identity = await app.inject({
    method: "PUT",
    url: "/api/users/me/identity",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      clerkUserId: "user_victim",
      clerkEmail: "victim@example.com",
    },
  });
  // Supabase offline — still must not mint cross-user access; route stays scoped to token.
  assert.equal(identity.statusCode, 503);

  const profile = await app.inject({
    method: "PUT",
    url: "/api/users/me/profile",
    headers: { authorization: `Bearer ${token}` },
    payload: { profile: { displayName: "hacked" } },
  });
  assert.equal(profile.statusCode, 503);

  // API auth still bound to attacker.
  const quota = await app.inject({
    method: "GET",
    url: "/api/replays/quota",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(quota.statusCode, 200);

  await app.close();
});

test("production rejects invite bypass and requireClerkSubject rejects invite-only tokens", async () => {
  resetSupabaseForTests();
  const prod = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: true,
    allowInviteLogin: true, // attempt to force-enable — must be ignored
    requireClerkSubject: false, // attempt to disable — must be forced true
    clerkIssuer: ISSUER,
    clerkJwksUrl: `${ISSUER}/.well-known/jwks.json`,
    clerkSessionVerifier: async () => null,
    replayDataFile: testDataFile(),
  });
  assert.equal(prod.allowInviteLogin, false);
  assert.equal(prod.requireClerkSubject, true);

  const app = await buildApp(prod);
  await app.ready();

  const inviteLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { inviteCode: "TEST-CODE" },
  });
  assert.equal(inviteLogin.statusCode, 401);

  const { token } = createToken("TEST-CODE", prod.authSecret);
  assert.equal(verifyToken(token, prod.authSecret)?.clerkUserId, undefined);
  const api = await app.inject({
    method: "GET",
    url: "/api/replays",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(api.statusCode, 401);

  await app.close();
});

test("expired PathGen token returns 401", async () => {
  resetSupabaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    isProduction: false,
    allowInviteLogin: true,
    requireClerkSubject: false,
    pathgenTokenTtlSec: 1,
    replayDataFile: testDataFile(),
  });
  const app = await buildApp(config);
  await app.ready();

  const { token } = createToken("TEST-CODE", config.authSecret, { ttlSec: -10 });
  const res = await app.inject({
    method: "GET",
    url: "/api/replays",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("missing PathGen bearer returns 401", async () => {
  resetSupabaseForTests();
  const config = loadConfig({
    port: 0,
    authSecret: "test-secret",
    inviteCodes: new Set(["TEST-CODE"]),
    osirionApiKey: "",
    supabaseDisabled: true,
    replayDataFile: testDataFile(),
  });
  const app = await buildApp(config);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/replays" });
  assert.equal(res.statusCode, 401);
  await app.close();
});
