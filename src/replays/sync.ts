import { normalizeOsirionToPathGen } from "./pathgenNormalizer.js";
import { OsirionClient } from "./osirionClient.js";
import type { ReplayStore } from "./replayStore.js";
import type { ReplayJob } from "./types.js";

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Replay processing failed.";
}

export async function syncReplayJob(
  job: ReplayJob,
  store: ReplayStore,
  osirion: OsirionClient,
): Promise<ReplayJob> {
  if (!job.providerTrackingId || job.status === "parsed" || job.status === "failed") return job;
  try {
    const status = await osirion.getUploadStatus(job.providerTrackingId);
    if (status.status === "COMPLETE" && status.matchId) {
      let nextJob =
        store.updateJob(job.id, {
          status: "fetching_match_data",
          providerMatchId: status.matchId,
          lastCheckedAt: new Date().toISOString(),
        }) ?? job;
      const match = await osirion.fetchMatch(status.matchId);
      const replay = normalizeOsirionToPathGen({
        jobId: job.id,
        userId: job.userId,
        fileName: job.fileName,
        fileHash: job.fileHash,
        createdAt: job.createdAt,
        match,
      });
      store.saveReplay(replay);
      nextJob =
        store.updateJob(job.id, {
          status: "parsed",
          replayId: replay.summary.id,
          parsedAt: replay.summary.parsedAt ?? new Date().toISOString(),
        }) ?? nextJob;
      return nextJob;
    }
    if (status.status === "FAILED") {
      return (
        store.updateJob(job.id, {
          status: "failed",
          errorCode: "OSIRION_PARSE_FAILED",
          errorMessage: status.error ?? "Replay failed to parse.",
          lastCheckedAt: new Date().toISOString(),
        }) ?? job
      );
    }
    return (
      store.updateJob(job.id, {
        status: "osirion_pending",
        lastCheckedAt: new Date().toISOString(),
      }) ?? job
    );
  } catch (error) {
    return (
      store.updateJob(job.id, {
        status: "failed",
        errorCode: "OSIRION_POLL_FAILED",
        errorMessage: safeError(error),
      }) ?? job
    );
  }
}

export async function syncPendingJobs(store: ReplayStore, osirion: OsirionClient): Promise<void> {
  for (const job of store.listPendingJobs()) {
    await syncReplayJob(job, store, osirion);
  }
}
