import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PathGenReplayDetail, ReplayJob, ReplayJobStatus } from "./types.js";
import { buildDeepAnalyzeQuota, type DeepAnalyzeQuota } from "./quota.js";
import type { PathGenConfig } from "../config.js";

interface DeepAnalyzeUsage {
  monthKey: string;
  monthCount: number;
  dayKey: string;
  dayCount: number;
  lastDeepAnalyzeAt?: string;
}

interface ReplayDb {
  jobs: ReplayJob[];
  replays: PathGenReplayDetail[];
  deepAnalyzeUsage: Record<string, DeepAnalyzeUsage>;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentDayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
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

  findReplayByMatchId(userId: string, matchId: string): PathGenReplayDetail | null {
    return (
      this.read().replays.find(
        (replay) => replay.summary.userId === userId && replay.summary.id === matchId,
      ) ?? null
    );
  }

  findReplayByHash(userId: string, fileHash: string): PathGenReplayDetail | null {
    return (
      this.read().replays.find(
        (replay) => replay.summary.userId === userId && replay.summary.fileHash === fileHash,
      ) ?? null
    );
  }

  getDeepAnalyzeUsage(userId: string): DeepAnalyzeUsage | undefined {
    const usage = this.read().deepAnalyzeUsage[userId];
    if (!usage) return undefined;
    if ("count" in usage && !("monthCount" in usage)) {
      const legacy = usage as { monthKey: string; count: number };
      return {
        monthKey: legacy.monthKey,
        monthCount: legacy.count,
        dayKey: currentDayKey(),
        dayCount: 0,
      };
    }
    return usage;
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

  getDeepAnalyzeQuota(userId: string, config: PathGenConfig): DeepAnalyzeQuota {
    return buildDeepAnalyzeQuota(userId, this.getDeepAnalyzeUsage(userId), config);
  }

  incrementDeepAnalyzeUsage(userId: string): void {
    const monthKey = currentMonthKey();
    const dayKey = currentDayKey();
    const db = this.read();
    const current = this.getDeepAnalyzeUsage(userId);
    const monthCount = current?.monthKey === monthKey ? current.monthCount + 1 : 1;
    const dayCount = current?.dayKey === dayKey ? current.dayCount + 1 : 1;
    db.deepAnalyzeUsage[userId] = {
      monthKey,
      monthCount,
      dayKey,
      dayCount,
      lastDeepAnalyzeAt: new Date().toISOString(),
    };
    this.write(db);
  }

  private read(): ReplayDb {
    if (!existsSync(this.filePath)) {
      return { jobs: [], replays: [], deepAnalyzeUsage: {} };
    }
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ReplayDb>;
    return {
      jobs: parsed.jobs ?? [],
      replays: parsed.replays ?? [],
      deepAnalyzeUsage: parsed.deepAnalyzeUsage ?? {},
    };
  }

  private write(db: ReplayDb): void {
    writeFileSync(this.filePath, `${JSON.stringify(db, null, 2)}\n`);
  }
}
