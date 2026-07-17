import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceUploadStatusPayload,
  normalizePlayersList,
  normalizeUploadStatus,
  resolveOsirionApiHost,
} from "../src/replays/osirionClient.js";

test("numeric STATUS_COMPLETE is complete", () => {
  assert.deepEqual(normalizeUploadStatus({ status: 2, matchId: "abc" }), {
    phase: "complete",
    matchId: "abc",
  });
});

test("STATUS_FAILED is failed", () => {
  assert.deepEqual(normalizeUploadStatus({ status: 3, error: "bad replay" }), {
    phase: "failed",
    error: "bad replay",
  });
});

test("complete without match id stays pending", () => {
  assert.deepEqual(normalizeUploadStatus({ status: "STATUS_COMPLETE" }), { phase: "pending" });
});

test("coerceUploadStatusPayload handles bare enum from SDK", () => {
  assert.deepEqual(coerceUploadStatusPayload(2), { status: 2 });
  assert.equal(normalizeUploadStatus(coerceUploadStatusPayload(2)).phase, "pending");
});

test("coerceUploadStatusPayload unwraps nested status objects", () => {
  const nested = coerceUploadStatusPayload({
    data: { status: 2, matchId: "abc123" },
  });
  assert.equal(normalizeUploadStatus(nested).phase, "complete");
});

test("coerceUploadStatusPayload unwraps { status: UploadStatus } envelope", () => {
  const wrapped = coerceUploadStatusPayload({
    status: { status: 2, matchId: "match_xyz" },
  });
  assert.deepEqual(normalizeUploadStatus(wrapped), {
    phase: "complete",
    matchId: "match_xyz",
  });
});

test("normalizePlayersList unwraps playerStatsWrappers", () => {
  const players = normalizePlayersList({
    playerStatsWrappers: [
      { playerStats: { isReplayOwner: true, placement: 7, eliminations: 3 }, isHidden: false },
      { playerStats: { placement: 12, eliminations: 0 }, isHidden: false },
    ],
  });
  assert.equal(players.length, 2);
  assert.equal(players[0]?.placement, 7);
  assert.equal(players[0]?.isReplayOwner, true);
});

test("resolveOsirionApiHost rejects website hosts that return HTML", () => {
  assert.equal(resolveOsirionApiHost(""), "https://api.osirion.gg");
  assert.equal(resolveOsirionApiHost("https://osirion.gg"), "https://api.osirion.gg");
  assert.equal(resolveOsirionApiHost("https://www.osirion.gg/app"), "https://api.osirion.gg");
  assert.equal(
    resolveOsirionApiHost("https://api.osirion.gg/"),
    "https://api.osirion.gg",
  );
});
