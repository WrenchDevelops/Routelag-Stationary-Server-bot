import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUploadStatus } from "../src/replays/osirionClient.js";

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
