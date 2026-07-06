import type { PathGenConfig } from "../config.js";
import { cloneReplayForJob, normalizeOsirionToPathGen } from "./pathgenNormalizer.js";
import { normalizeUploadStatus, OsirionClient } from "./osirionClient.js";
import type { ReplayStore } from "./replayStore.js";
import type { ReplayJob } from "./types.js";

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Replay processing failed.";
}

function pollIntervalMs(value: number | undefined): number {
  return Math.max(value ?? 90_000, 60_000);
}

function scheduleNextPoll(intervalMs: number, from = Date.now()): string {
  return new Date(from + intervalMs).toISOString();
}

function shouldPollOsirion(
  job: ReplayJob,
  intervalMs: number,
  maxPolls: number,
  force = false,
): boolean {
  if (force) return true;
  if (job.status === "fetching_match_data") return false;
  if ((job.statusPollCount ?? 0) >= maxPolls) return false;
  if (job.nextPollAt && Date.now() < new Date(job.nextPollAt).getTime()) return false;
  if (!job.lastCheckedAt) return true;
  return Date.now() - new Date(job.lastCheckedAt).getTime() >= intervalMs;
}

export async function syncReplayJob(
  job: ReplayJob,
  store: ReplayStore,
  osirion: OsirionClient,
  config: PathGenConfig,
  options?: { force?: boolean },
): Promise<ReplayJob> {
  if (!job.providerTrackingId || job.status === "parsed" || job.status === "failed") return job;

  const intervalMs = pollIntervalMs(config.replayPollIntervalMs);
  if (!shouldPollOsirion(job, intervalMs, config.replayMaxStatusPolls, options?.force)) {
    return job;
  }

  const pollCount = (job.statusPollCount ?? 0) + 1;

  try {
    const status = normalizeUploadStatus(await osirion.getUploadStatus(job.providerTrackingId));
    if (status.phase === "complete") {
      const cached = store.findReplayByMatchId(job.userId, status.matchId);
      if (cached) {
        const replay = cloneReplayForJob(cached, {
          jobId: job.id,
          fileName: job.fileName,
          fileHash: job.fileHash,
          createdAt: job.createdAt,
        });
        store.saveReplay(replay);
        return (
          store.updateJob(job.id, {
            status: "parsed",
            providerMatchId: status.matchId,
            replayId: replay.summary.id,
            parsedAt: replay.summary.parsedAt ?? new Date().toISOString(),
            lastCheckedAt: new Date().toISOString(),
            statusPollCount: pollCount,
          }) ?? job
        );
      }

      let nextJob =
        store.updateJob(job.id, {
          status: "fetching_match_data",
          providerMatchId: status.matchId,
          lastCheckedAt: new Date().toISOString(),
          statusPollCount: pollCount,
        }) ?? job;
      const match = await osirion.fetchBasicMatch(status.matchId, config.basicParsePlayersOnly);
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
    if (status.phase === "failed") {
      return (
        store.updateJob(job.id, {
          status: "failed",
          errorCode: "OSIRION_PARSE_FAILED",
          errorMessage: status.error ?? "Replay failed to parse.",
          lastCheckedAt: new Date().toISOString(),
          statusPollCount: pollCount,
        }) ?? job
      );
    }
    return (
      store.updateJob(job.id, {
        status: "osirion_pending",
        lastCheckedAt: new Date().toISOString(),
        statusPollCount: pollCount,
        nextPollAt: scheduleNextPoll(intervalMs),
      }) ?? job
    );
  } catch (error) {
    return (
      store.updateJob(job.id, {
        status: "failed",
        errorCode: "OSIRION_POLL_FAILED",
        errorMessage: safeError(error),
        statusPollCount: pollCount,
      }) ?? job
    );
  }
}

export async function syncPendingJobs(
  store: ReplayStore,
  osirion: OsirionClient,
  config: PathGenConfig,
): Promise<void> {
  for (const job of store.listPendingJobs()) {
    await syncReplayJob(job, store, osirion, config);
  }
}

export function initialNextPollAt(config: PathGenConfig, from = Date.now()): string {
  return new Date(from + config.replayFirstPollDelayMs).toISOString();
}
