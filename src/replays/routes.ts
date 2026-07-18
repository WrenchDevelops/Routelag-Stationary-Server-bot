import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";

import { secureEquals, type TokenClaims } from "../auth.js";
import type { PathGenConfig } from "../config.js";
import { OsirionClient } from "./osirionClient.js";
import { normalizeOsirionToPathGen } from "./pathgenNormalizer.js";
import type { ReplayStore } from "./replayStore.js";
import { syncReplayJob, initialNextPollAt } from "./sync.js";
import { runDeepAnalyze } from "./deepAnalyze.js";
import type { PathGenReplayDetail, ReplayJob } from "./types.js";

interface AuthedReplayRequest extends FastifyRequest {
  tester: TokenClaims;
}

export async function registerReplayRoutes(
  app: FastifyInstance,
  config: PathGenConfig,
  store: ReplayStore,
) {
  const maxBytes = config.replayUploadMaxMb * 1024 * 1024;
  const osirion = new OsirionClient(config);
  mkdirSync(config.replayStorageDir, { recursive: true });

  await app.register(multipart, {
    limits: {
      fileSize: maxBytes,
      files: 1,
    },
  });

  async function prepareTester(tester: TokenClaims) {
    store.rememberClerkIdentity(tester.testerId, tester.clerkUserId);
    // Only migrate for real allowlisted invite secrets — never the shared "clerk" sentinel.
    const invite = tester.inviteCode?.trim() ?? "";
    let allowlistedInvite = "";
    if (invite && invite.toLowerCase() !== "clerk" && !invite.includes("@")) {
      if (config.inviteCodes.has(invite)) {
        allowlistedInvite = invite;
      } else {
        const lower = invite.toLowerCase();
        for (const code of config.inviteCodes) {
          if (code.toLowerCase() === lower) {
            allowlistedInvite = code;
            break;
          }
        }
      }
    }
    if (allowlistedInvite) {
      store.migrateInviteOwnership(allowlistedInvite, tester.testerId);
    }
    try {
      await store.hydrateFromCloud(tester.testerId, tester.clerkUserId);
    } catch (error) {
      console.warn("[PathGen] Cloud replay hydrate failed:", error);
    }
    store.repairReplaySummaries(tester.testerId);
  }

  app.post("/api/replays/upload", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "Replay file is required." });

    const originalName = sanitizeFileName(part.filename);
    if (extname(originalName).toLowerCase() !== ".replay") {
      await part.file.resume();
      return reply.code(400).send({ error: "Only Fortnite .replay files can be uploaded." });
    }

    const localName = `${Date.now()}-${tester.testerId}-${originalName}`;
    const savedPath = join(config.replayStorageDir, localName);
    const hash = createHash("sha256");
    part.file.on("data", (chunk) => hash.update(chunk));

    try {
      await pipeline(part.file, createWriteStream(savedPath, { flags: "wx" }));
    } catch (error) {
      unlinkIfExists(savedPath);
      return reply.code(400).send({ error: uploadError(error) });
    }

    const size = statSync(savedPath).size;
    if (part.file.truncated) {
      unlinkIfExists(savedPath);
      return reply.code(413).send({ error: `Replay is larger than ${config.replayUploadMaxMb} MB.` });
    }
    if (size > maxBytes) {
      unlinkIfExists(savedPath);
      return reply.code(413).send({ error: `Replay is larger than ${config.replayUploadMaxMb} MB.` });
    }

    const fileHash = hash.digest("hex");
    const existingReplay = store.findReplayByHash(tester.testerId, fileHash);
    if (existingReplay) {
      unlinkIfExists(savedPath);
      const existingJob = store.getJob(existingReplay.summary.jobId, tester.testerId);
      return {
        duplicate: true,
        job: existingJob,
        replay: normalizeReplaySummary(existingReplay.summary),
      };
    }
    const duplicate = store.findJobByHash(tester.testerId, fileHash);
    if (duplicate && duplicate.status !== "failed") {
      unlinkIfExists(savedPath);
      return {
        duplicate: true,
        job: duplicate,
      };
    }

    let job = store.createJob({
      userId: tester.testerId,
      inviteCode: tester.inviteCode,
      fileName: originalName,
      fileHash,
      fileSizeBytes: size,
      status: "uploaded",
      provider: "osirion",
    });

    try {
      const submitted = await osirion.submitReplayFile(savedPath);
      job =
        store.updateJob(job.id, {
          providerTrackingId: submitted.trackingId,
          status: "osirion_pending",
          nextPollAt: initialNextPollAt(config),
          statusPollCount: 0,
        }) ?? job;
    } catch (error) {
      job =
        store.updateJob(job.id, {
          status: "failed",
          errorCode: "OSIRION_SUBMIT_FAILED",
          errorMessage: safeError(error),
        }) ?? job;
    } finally {
      // Keep only parsed JSON in Supabase — discard the uploaded .replay binary.
      unlinkIfExists(savedPath);
    }

    return reply.code(201).send({ duplicate: false, job });
  });

  app.get("/api/replays/quota", async (request) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    return store.getDeepAnalyzeQuota(tester.testerId, config);
  });

  app.get("/api/replays", async (request) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    return {
      replays: store.listReplays(tester.testerId).map((replay) => normalizeReplaySummary(replay.summary)),
    };
  });

  app.get("/api/replays/jobs", async (request) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    return { jobs: store.listJobs(tester.testerId) };
  });

  app.get<{ Params: { jobId: string }; Querystring: { sync?: string } }>(
    "/api/replays/jobs/:jobId",
    async (request, reply) => {
      const tester = (request as AuthedReplayRequest).tester;
      await prepareTester(tester);
      let job = store.getJob(request.params.jobId, tester.testerId);
      if (!job) return reply.code(404).send({ error: "Replay job not found." });
      if (request.query.sync === "1") {
        job = await syncReplayJob(job, store, osirion, config, { force: true });
      }
      return { job };
    },
  );

  app.post<{ Params: { jobId: string } }>("/api/replays/jobs/:jobId/retry", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    const job = store.getJob(request.params.jobId, tester.testerId);
    if (!job) return reply.code(404).send({ error: "Replay job not found." });
    if (!job.providerTrackingId) {
      return reply.code(400).send({ error: "This job has no Osirion tracking id. Re-upload the replay." });
    }
    const reset =
      store.updateJob(job.id, {
        status: "osirion_pending",
        errorCode: undefined,
        errorMessage: undefined,
        statusPollCount: 0,
        nextPollAt: new Date().toISOString(),
      }) ?? job;
    const synced = await syncReplayJob(reset, store, osirion, config, { force: true });
    return { job: synced };
  });

  app.get<{ Params: { replayId: string } }>("/api/replays/:replayId", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    const replay = store.getReplay(request.params.replayId, tester.testerId);
    if (!replay) return reply.code(404).send({ error: "Replay not found." });
    return { replay: publicReplay(replay) };
  });

  app.delete<{ Params: { replayId: string } }>("/api/replays/:replayId", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    const deleted = store.deleteReplay(request.params.replayId, tester.testerId);
    if (!deleted) return reply.code(404).send({ error: "Replay not found." });
    return { ok: true };
  });

  app.post<{ Params: { replayId: string } }>(
    "/api/replays/:replayId/deep-analyze",
    async (request, reply) => {
      const tester = (request as AuthedReplayRequest).tester;
      await prepareTester(tester);
      try {
        const replay = await runDeepAnalyze(
          request.params.replayId,
          tester.testerId,
          store,
          osirion,
          config,
        );
        const quota = store.getDeepAnalyzeQuota(tester.testerId, config);
        return { replay: publicReplay(replay), quota };
      } catch (error) {
        const message = safeError(error);
        const status =
          message.includes("limit reached") ||
          message.includes("wait") ||
          message.includes("used all")
            ? 402
            : 400;
        return reply.code(status).send({ error: message });
      }
    },
  );

  app.post<{ Params: { replayId: string } }>("/api/replays/:replayId/reparse", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    await prepareTester(tester);
    const replay = store.getReplay(request.params.replayId, tester.testerId);
    if (!replay) return reply.code(404).send({ error: "Replay not found." });
    const job = store.getJob(replay.summary.jobId, tester.testerId);
    if (!job?.providerTrackingId) {
      return reply.code(400).send({ error: "This replay has no Osirion tracking id. Re-upload the file." });
    }
    const reset =
      store.updateJob(replay.summary.jobId, {
        status: "osirion_pending",
        errorCode: undefined,
        errorMessage: undefined,
        statusPollCount: 0,
        nextPollAt: new Date().toISOString(),
      }) ?? job;
    const synced = await syncReplayJob(reset, store, osirion, config, { force: true });
    return { job: synced };
  });

  app.post("/api/replays/osirion/webhook", async (request, reply) => {
    if (!config.osirionWebhookSecret) return reply.code(404).send({ error: "Not found" });
    const header = String(request.headers["x-osirion-signature"] ?? "");
    if (!secureEquals(header, config.osirionWebhookSecret)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // Kick pending jobs immediately so we don't wait for the poll timer.
    const pending = store.listPendingJobs();
    let synced = 0;
    for (const job of pending) {
      await syncReplayJob(job, store, osirion, config, { force: true });
      synced += 1;
    }
    return { ok: true, synced };
  });
}

function publicReplay(replay: PathGenReplayDetail): PathGenReplayDetail {
  const { rawProviderMetadata, ...safeReplay } = replay;
  return {
    ...safeReplay,
    summary: normalizeReplaySummary(safeReplay.summary),
  };
}

function normalizeReplaySummary(summary: PathGenReplayDetail["summary"]) {
  return {
    ...summary,
    parseTier: summary.parseTier ?? "basic",
    deepParseStatus:
      summary.deepParseStatus ?? (summary.status === "parsed" ? "available" : "none"),
  };
}

function sanitizeFileName(fileName: string): string {
  return basename(fileName).replace(/[^A-Za-z0-9._ -]/g, "_");
}

function unlinkIfExists(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup.
  }
}

function uploadError(error: unknown) {
  const message = safeError(error);
  return message.includes("File too large") ? "Replay is too large." : message;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Replay processing failed.";
}

export type { ReplayJob };
