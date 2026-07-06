import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PathGenReplayDetail, ReplayJob, ReplayJobStatus } from "./types.js";

interface ReplayDb {
  jobs: ReplayJob[];
  replays: PathGenReplayDetail[];
}

export class ReplayStore {
  private readonly filePath: string;

  constructor(dataFile: string) {
    this.filePath = dataFile.endsWith(".json") ? dataFile : join(dirname(dataFile), "replays.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  listJobs(userId: string): ReplayJob[] {
    return this.read().jobs.filter((job) => job.userId === userId);
  }

  listPendingJobs(): ReplayJob[] {
    return this.read().jobs.filter(
      (job) =>
        Boolean(job.providerTrackingId) &&
        job.status !== "parsed" &&
        job.status !== "failed",
    );
  }

  getJob(jobId: string, userId: string): ReplayJob | null {
    return this.read().jobs.find((job) => job.id === jobId && job.userId === userId) ?? null;
  }

  findJobByHash(userId: string, fileHash: string): ReplayJob | null {
    return this.read().jobs.find((job) => job.userId === userId && job.fileHash === fileHash) ?? null;
  }

  createJob(input: Omit<ReplayJob, "id" | "createdAt" | "updatedAt">): ReplayJob {
    const db = this.read();
    const now = new Date().toISOString();
    const job: ReplayJob = {
      ...input,
      id: `replay_job_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };
    db.jobs.push(job);
    this.write(db);
    return job;
  }

  updateJob(jobId: string, patch: Partial<Omit<ReplayJob, "id" | "createdAt">>): ReplayJob | null {
    const db = this.read();
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.write(db);
    return job;
  }

  listReplays(userId: string): PathGenReplayDetail[] {
    return this.read().replays.filter((replay) => replay.summary.userId === userId);
  }

  getReplay(replayId: string, userId: string): PathGenReplayDetail | null {
    return (
      this.read().replays.find(
        (replay) => replay.summary.id === replayId && replay.summary.userId === userId,
      ) ?? null
    );
  }

  saveReplay(replay: PathGenReplayDetail): PathGenReplayDetail {
    const db = this.read();
    const existingIndex = db.replays.findIndex((item) => item.summary.id === replay.summary.id);
    if (existingIndex >= 0) {
      db.replays[existingIndex] = replay;
    } else {
      db.replays.push(replay);
    }
    this.write(db);
    return replay;
  }

  setJobStatus(jobId: string, status: ReplayJobStatus, errorMessage?: string): ReplayJob | null {
    return this.updateJob(jobId, {
      status,
      errorMessage,
      errorCode: errorMessage ? "REPLAY_PARSE_ERROR" : undefined,
    });
  }

  private read(): ReplayDb {
    if (!existsSync(this.filePath)) {
      return { jobs: [], replays: [] };
    }
    return JSON.parse(readFileSync(this.filePath, "utf8")) as ReplayDb;
  }

  private write(db: ReplayDb): void {
    writeFileSync(this.filePath, `${JSON.stringify(db, null, 2)}\n`);
  }
}
