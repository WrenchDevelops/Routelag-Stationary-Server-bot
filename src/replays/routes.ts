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
import { syncReplayJob } from "./sync.js";
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

  app.post("/api/replays/upload", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
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
        }) ?? job;
    } catch (error) {
      job =
        store.updateJob(job.id, {
          status: "failed",
          errorCode: "OSIRION_SUBMIT_FAILED",
          errorMessage: safeError(error),
        }) ?? job;
    }

    return reply.code(201).send({ duplicate: false, job });
  });

  app.get("/api/replays/jobs", async (request) => {
    const tester = (request as AuthedReplayRequest).tester;
    return { jobs: store.listJobs(tester.testerId) };
  });

  app.get<{ Params: { jobId: string } }>("/api/replays/jobs/:jobId", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    let job = store.getJob(request.params.jobId, tester.testerId);
    if (!job) return reply.code(404).send({ error: "Replay job not found." });
    job = await syncReplayJob(job, store, osirion);
    return { job };
  });

  app.get("/api/replays", async (request) => {
    const tester = (request as AuthedReplayRequest).tester;
    return {
      replays: store.listReplays(tester.testerId).map((replay) => replay.summary),
    };
  });

  app.get<{ Params: { replayId: string } }>("/api/replays/:replayId", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    const replay = store.getReplay(request.params.replayId, tester.testerId);
    if (!replay) return reply.code(404).send({ error: "Replay not found." });
    return { replay: publicReplay(replay) };
  });

  app.post<{ Params: { replayId: string } }>("/api/replays/:replayId/reparse", async (request, reply) => {
    const tester = (request as AuthedReplayRequest).tester;
    const replay = store.getReplay(request.params.replayId, tester.testerId);
    if (!replay) return reply.code(404).send({ error: "Replay not found." });
    const job = store.updateJob(replay.summary.jobId, {
      status: "osirion_pending",
      errorCode: undefined,
      errorMessage: undefined,
    });
    return { job: job ?? null };
  });

  app.post("/api/replays/osirion/webhook", async (request, reply) => {
    if (!config.osirionWebhookSecret) return reply.code(404).send({ error: "Not found" });
    const header = String(request.headers["x-osirion-signature"] ?? "");
    if (!secureEquals(header, config.osirionWebhookSecret)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return { ok: true };
  });
}

function publicReplay(replay: PathGenReplayDetail): PathGenReplayDetail {
  const { rawProviderMetadata, ...safeReplay } = replay;
  return safeReplay;
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
