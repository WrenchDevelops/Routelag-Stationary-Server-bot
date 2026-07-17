import type { PathGenConfig } from "../config.js";
import { cloneReplayForJob, normalizeOsirionToPathGen } from "./pathgenNormalizer.js";
import { normalizeUploadStatus, OsirionClient } from "./osirionClient.js";
import type { ReplayStore } from "./replayStore.js";
import type { ReplayJob } from "./types.js";

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Replay processing failed.";
}

function pollIntervalMs(value: number | undefined): number {
  return Math.max(value ?? 90_000, 15_000);
}

function scheduleNextPoll(intervalMs: number, from = Date.now()): string {
  return new Date(from + intervalMs).toISOString();
}

function shouldPollOsirion(
  job: ReplayJob,
  intervalMs: number,
  maxPolls: number,
  force = false,
): "poll" | "skip" | "timeout" {
  if (force) return "poll";
  if (job.status === "fetching_match_data") return "skip";
  if ((job.statusPollCount ?? 0) >= maxPolls) return "timeout";
  if (job.nextPollAt && Date.now() < new Date(job.nextPollAt).getTime()) return "skip";
  if (!job.lastCheckedAt) return "poll";
  return Date.now() - new Date(job.lastCheckedAt).getTime() >= intervalMs ? "poll" : "skip";
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
  const decision = shouldPollOsirion(job, intervalMs, config.replayMaxStatusPolls, options?.force);
  if (decision === "skip") return job;
  if (decision === "timeout") {
    return (
      store.updateJob(job.id, {
        status: "failed",
        errorCode: "OSIRION_POLL_TIMEOUT",
        errorMessage:
          "Timed out waiting for Osirion to finish parsing. Use Retry Parse or re-upload the replay.",
        lastCheckedAt: new Date().toISOString(),
      }) ?? job
    );
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
          userId: job.userId,
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
            errorCode: undefined,
            errorMessage: undefined,
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
      const match = await osirion.fetchBasicMatch(
        status.matchId,
        config.basicParsePlayersOnly,
      );
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
          errorCode: undefined,
          errorMessage: undefined,
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
    const message = safeError(error);
    // Transient HTML/JSON parse failures (bad base URL, edge HTML, brief outages)
    // should not permanently fail a job that Osirion may already have parsed.
    const transient =
      /Unexpected token\s*</i.test(message) ||
      /returned HTML instead of JSON/i.test(message) ||
      /returned non-JSON/i.test(message) ||
      /fetch failed/i.test(message) ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message);

    if (transient && pollCount < config.replayMaxStatusPolls) {
      return (
        store.updateJob(job.id, {
          status: "osirion_pending",
          lastCheckedAt: new Date().toISOString(),
          statusPollCount: pollCount,
          nextPollAt: scheduleNextPoll(Math.min(intervalMs, 30_000)),
          errorCode: "OSIRION_POLL_RETRYING",
          errorMessage: `Temporary Osirion status error (will retry): ${message}`,
        }) ?? job
      );
    }

    return (
      store.updateJob(job.id, {
        status: "failed",
        errorCode: "OSIRION_POLL_FAILED",
        errorMessage: message,
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
  return new Date(from + Math.max(config.replayFirstPollDelayMs, 5_000)).toISOString();
}
