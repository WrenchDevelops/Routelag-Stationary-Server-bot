import type { PathGenConfig } from "../config.js";
import { DEEP_ANALYZE_EVENT_TYPES } from "./constants.js";
import { mergeDeepParseIntoReplay } from "./pathgenNormalizer.js";
import { OsirionClient } from "./osirionClient.js";
import { deepAnalyzeBlockReason } from "./quota.js";
import type { ReplayStore } from "./replayStore.js";
import type { PathGenReplayDetail } from "./types.js";

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Deep analyze failed.";
}

export async function runDeepAnalyze(
  replayId: string,
  userId: string,
  store: ReplayStore,
  osirion: OsirionClient,
  config: PathGenConfig,
): Promise<PathGenReplayDetail> {
  const replay = store.getReplay(replayId, userId);
  if (!replay) {
    throw new Error("Replay not found.");
  }
  if (replay.summary.status !== "parsed") {
    throw new Error("Basic summary is not ready yet.");
  }
  if (replay.summary.deepParseStatus === "parsed") {
    return replay;
  }
  if (replay.summary.deepParseStatus === "analyzing") {
    throw new Error("Deep analyze is already running for this replay.");
  }

  const quota = store.getDeepAnalyzeQuota(userId, config);
  const blocked = deepAnalyzeBlockReason(quota);
  if (blocked) {
    throw new Error(blocked);
  }

  const matchId = String(replay.summary.id);
  store.saveReplay({
    ...replay,
    summary: { ...replay.summary, deepParseStatus: "analyzing" },
  });

  try {
    const deep = (await osirion.fetchDeepMatchData(matchId, [...DEEP_ANALYZE_EVENT_TYPES])) as {
      weapons?: unknown;
      zoneStats?: unknown;
      events?: Record<string, unknown>;
    };
    const merged = mergeDeepParseIntoReplay(replay, deep);
    store.saveReplay(merged);
    store.incrementDeepAnalyzeUsage(userId);
    return merged;
  } catch (error) {
    const failed = store.getReplay(replayId, userId);
    if (failed) {
      store.saveReplay({
        ...failed,
        summary: {
          ...failed.summary,
          deepParseStatus: "failed",
          deepParseError: safeError(error),
        },
      });
    }
    throw error;
  }
}
