import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeTimestamp, normalizeOsirionToPathGen } from "../src/replays/pathgenNormalizer.js";
import { ReplayStore } from "../src/replays/replayStore.js";
import { coerceUploadStatusPayload, normalizeUploadStatus } from "../src/replays/osirionClient.js";

test("normalizeTimestamp converts Osirion microseconds to ISO", () => {
  const iso = normalizeTimestamp(1783219592071000);
  assert.ok(iso);
  assert.equal(new Date(iso!).getUTCFullYear(), 2026);
  assert.equal(new Date(iso!).getUTCMonth(), 6);
  assert.equal(new Date(iso!).getUTCDate(), 5);
});

test("normalizeOsirionToPathGen maps player combat stats and meters", () => {
  const replay = normalizeOsirionToPathGen({
    jobId: "job_1",
    userId: "tester_stable",
    fileName: "match.replay",
    fileHash: "abc",
    createdAt: "2026-07-04T00:00:00.000Z",
    match: {
      info: {
        matchId: "match_1",
        gameMode: "Playlist_DefaultSquad",
        startTimestamp: 1783219592071000,
        lengthMs: 957430,
      },
      players: [
        {
          isReplayOwner: true,
          placement: 3,
          eliminations: 2,
          assists: 1,
          deaths: 1,
          damageToPlayers: 132.7,
          damageTakenFromPlayers: 90,
          shots: 10,
          hits: 4,
          matchmakingRegion: "NAC",
          distanceTraveledOnFoot: 183675.77,
          distanceTraveledSkydiving: 45793.188,
          timeAlive: 829.6,
        },
      ],
      events: {},
    },
  });

  assert.equal(replay.summary.placement, 3);
  assert.equal(replay.summary.eliminations, 2);
  assert.equal(replay.summary.damageDealt, 133);
  assert.equal(replay.summary.accuracy, 40);
  assert.equal(replay.summary.durationSeconds, 957);
  assert.ok((replay.summary.distanceTraveled ?? 0) > 1000);
  assert.ok((replay.summary.distanceTraveled ?? 0) < 5000);
  assert.equal(new Date(String(replay.summary.startedAt)).getUTCFullYear(), 2026);
});

test("migrateInviteOwnership reattaches legacy UUID tester ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "pathgen-migrate-"));
  const file = join(dir, "db.json");
  writeFileSync(
    file,
    JSON.stringify({
      jobs: [
        {
          id: "replay_job_1",
          userId: "tester_ce56cbe9-7d8a-4d32-a394-7f0cda2a2c59",
          inviteCode: "WRENCH-TEST",
          fileName: "a.replay",
          fileHash: "hash1",
          fileSizeBytes: 10,
          status: "parsed",
          provider: "osirion",
          createdAt: "2026-07-04T00:00:00.000Z",
          updatedAt: "2026-07-04T00:00:00.000Z",
          replayId: "match_1",
        },
      ],
      replays: [
        {
          summary: {
            id: "match_1",
            userId: "tester_ce56cbe9-7d8a-4d32-a394-7f0cda2a2c59",
            jobId: "replay_job_1",
            fileName: "a.replay",
            fileHash: "hash1",
            status: "parsed",
            parseTier: "basic",
            deepParseStatus: "available",
            startedAt: 1783219592071000,
            distanceTraveled: 229468,
            damageDealt: 32.7,
            createdAt: "2026-07-04T00:00:00.000Z",
          },
          keyMoments: [],
          player: {
            distanceTraveledOnFoot: 183675,
            distanceTraveledSkydiving: 45793,
          },
        },
      ],
      deepAnalyzeUsage: {},
    }),
  );

  const store = new ReplayStore(file);
  const moved = store.migrateInviteOwnership("WRENCH-TEST", "tester_17676b4ca005773154a4ac16");
  assert.ok(moved >= 2);
  assert.equal(store.listReplays("tester_17676b4ca005773154a4ac16").length, 1);
  assert.equal(store.listJobs("tester_17676b4ca005773154a4ac16").length, 1);

  const repaired = store.repairReplaySummaries("tester_17676b4ca005773154a4ac16");
  assert.ok(repaired >= 1);
  const replay = store.listReplays("tester_17676b4ca005773154a4ac16")[0]!;
  assert.equal(typeof replay.summary.startedAt, "string");
  assert.ok((replay.summary.distanceTraveled ?? 0) < 5000);
});

test("coerceUploadStatusPayload unwraps nested status objects", () => {
  const nested = coerceUploadStatusPayload({
    data: { status: 2, matchId: "abc123" },
  });
  assert.equal(normalizeUploadStatus(nested).phase, "complete");
});

test("normalizeOsirionToPathGen unwraps playerStatsWrappers and fills combat stats", () => {
  const replay = normalizeOsirionToPathGen({
    jobId: "job_2",
    userId: "tester_stable",
    fileName: "wrapped.replay",
    fileHash: "def",
    createdAt: "2026-07-04T00:00:00.000Z",
    match: {
      info: { matchId: "match_2", lengthMs: 120000 },
      players: {
        playerStatsWrappers: [
          {
            isHidden: false,
            playerStats: {
              isReplayOwner: true,
              placement: 5,
              humanElims: 4,
              damageToPlayers: 501.2,
              timeAlive: 110,
            },
          },
        ],
      },
      events: {},
    },
  });

  assert.equal(replay.summary.placement, 5);
  assert.equal(replay.summary.eliminations, 4);
  assert.equal(replay.summary.damageDealt, 501);
  assert.equal(replay.summary.durationSeconds, 120);
});
