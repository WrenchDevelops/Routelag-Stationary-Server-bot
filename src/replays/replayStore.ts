import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PathGenReplayDetail, ReplayJob, ReplayJobStatus } from "./types.js";
import { buildDeepAnalyzeQuota, type DeepAnalyzeQuota } from "./quota.js";
import type { PathGenConfig } from "../config.js";
import type { CloudDataSync } from "../cloud/supabaseSync.js";
import { backfillSummaryFromPlayer, normalizeTimestamp } from "./pathgenNormalizer.js";

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
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

export class ReplayStore {
  private readonly filePath: string;
  private cloud: CloudDataSync | null = null;
  /** testerId -> clerkUserId for cloud dual-writes */
  private readonly clerkByTester = new Map<string, string>();

  constructor(dataFile: string) {
    this.filePath = dataFile.endsWith(".json") ? dataFile : join(dirname(dataFile), "replays.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  setCloudSync(cloud: CloudDataSync | null) {
    this.cloud = cloud;
  }

  rememberClerkIdentity(testerId: string, clerkUserId?: string | null) {
    const id = clerkUserId?.trim();
    if (!testerId || !id) return;
    this.clerkByTester.set(testerId, id);
  }

  private clerkFor(userId: string): string | null {
    return this.clerkByTester.get(userId) ?? null;
  }

  private syncJob(job: ReplayJob) {
    void this.cloud?.upsertReplayJob(job, this.clerkFor(job.userId)).catch(() => undefined);
  }

  private syncReplay(replay: PathGenReplayDetail) {
    void this.cloud
      ?.upsertReplay(replay, this.clerkFor(replay.summary.userId))
      .catch(() => undefined);
  }

  private syncUsage(userId: string, usage: DeepAnalyzeUsage) {
    void this.cloud?.upsertDeepAnalyzeUsage(userId, usage).catch(() => undefined);
  }

  /**
   * Pull parsed jobs/replays from Supabase into the local cache so Railway
   * redeploys never wipe the desktop library. Source of truth is cloud JSON.
   */
  async hydrateFromCloud(userId: string, clerkUserId?: string | null): Promise<number> {
    if (!this.cloud?.enabled) return 0;
    this.rememberClerkIdentity(userId, clerkUserId);

    const [cloudJobs, cloudReplays] = await Promise.all([
      this.cloud.listJobs(userId, clerkUserId),
      this.cloud.listReplays(userId, clerkUserId),
    ]);

    if (cloudJobs.length === 0 && cloudReplays.length === 0) return 0;

    const db = this.read();
    let changed = 0;

    for (const job of cloudJobs) {
      // Keep cloud ownership when present; never reassign another tester's row.
      const ownerId = job.userId && job.userId !== userId ? job.userId : userId;
      if (ownerId !== userId) continue;
      const normalized: ReplayJob = { ...job, userId };
      const idx = db.jobs.findIndex((item) => item.id === normalized.id);
      if (idx < 0) {
        db.jobs.push(normalized);
        changed += 1;
        continue;
      }
      const local = db.jobs[idx]!;
      if (local.userId && local.userId !== userId) continue;
      if (Date.parse(normalized.updatedAt) >= Date.parse(local.updatedAt)) {
        db.jobs[idx] = { ...local, ...normalized, userId };
        changed += 1;
      }
    }

    for (const replay of cloudReplays) {
      const ownerId =
        replay.summary.userId && replay.summary.userId !== userId
          ? replay.summary.userId
          : userId;
      if (ownerId !== userId) continue;
      const normalized: PathGenReplayDetail = {
        ...replay,
        summary: { ...replay.summary, userId },
      };
      const idx = db.replays.findIndex((item) => item.summary.id === normalized.summary.id);
      if (idx < 0) {
        db.replays.push(normalized);
        changed += 1;
        continue;
      }
      const local = db.replays[idx]!;
      if (local.summary.userId && local.summary.userId !== userId) continue;
      const localTs = Date.parse(String(local.summary.parsedAt ?? local.summary.createdAt)) || 0;
      const cloudTs =
        Date.parse(String(normalized.summary.parsedAt ?? normalized.summary.createdAt)) || 0;
      if (cloudTs >= localTs || !local.keyMoments?.length) {
        db.replays[idx] = normalized;
        changed += 1;
      }
    }

    if (changed > 0) this.write(db);
    return changed;
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
    this.syncJob(job);
    return job;
  }

  updateJob(jobId: string, patch: Partial<Omit<ReplayJob, "id" | "createdAt">>): ReplayJob | null {
    const db = this.read();
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.write(db);
    this.syncJob(job);
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

  /** Ownership-scoped delete — returns false when the replay is missing or not owned. */
  deleteReplay(replayId: string, userId: string): boolean {
    const db = this.read();
    const index = db.replays.findIndex(
      (replay) => replay.summary.id === replayId && replay.summary.userId === userId,
    );
    if (index < 0) return false;
    const [removed] = db.replays.splice(index, 1);
    db.jobs = db.jobs.filter(
      (job) => !(job.id === removed?.summary.jobId && job.userId === userId),
    );
    this.write(db);
    return true;
  }

  /**
   * Re-attach jobs/replays created under older random tester IDs to the stable
   * invite-derived testerId so the desktop library is not empty after re-login.
   *
   * Only real allowlisted invite codes may migrate. The Clerk sentinel `"clerk"`
   * is shared by every Clerk-authenticated user and must never move ownership.
   */
  migrateInviteOwnership(inviteCode: string, testerId: string): number {
    const code = inviteCode.trim();
    if (!code || code.toLowerCase() === "clerk") return 0;
    // Emails / free-form body strings are not shared invite secrets.
    if (code.includes("@")) return 0;
    const db = this.read();
    let moved = 0;

    const legacyUserIds = new Set(
      db.jobs
        .filter((job) => job.inviteCode === code && job.userId !== testerId)
        .map((job) => job.userId),
    );

    const ownedJobIds = new Set<string>();
    for (const job of db.jobs) {
      if (job.inviteCode === code && job.userId !== testerId) {
        job.userId = testerId;
        job.updatedAt = new Date().toISOString();
        moved += 1;
        this.syncJob(job);
      }
      if (job.inviteCode === code || job.userId === testerId) {
        ownedJobIds.add(job.id);
      }
    }

    for (const replay of db.replays) {
      const belongs =
        ownedJobIds.has(replay.summary.jobId) ||
        legacyUserIds.has(replay.summary.userId) ||
        db.jobs.some((job) => job.id === replay.summary.jobId && job.inviteCode === code);
      if (belongs && replay.summary.userId !== testerId) {
        replay.summary.userId = testerId;
        moved += 1;
        this.syncReplay(replay);
      }
    }

    for (const legacyKey of legacyUserIds) {
      const legacy = db.deepAnalyzeUsage[legacyKey];
      if (!legacy) continue;
      if (!db.deepAnalyzeUsage[testerId]) {
        db.deepAnalyzeUsage[testerId] = legacy;
        delete db.deepAnalyzeUsage[legacyKey];
        moved += 1;
        this.syncUsage(testerId, legacy);
      }
    }

    if (moved > 0) this.write(db);
    return moved;
  }

  /** Repair summaries: timestamps, distances, and missing combat stats from raw player. */
  repairReplaySummaries(userId: string): number {
    const db = this.read();
    let repaired = 0;
    for (const replay of db.replays) {
      if (replay.summary.userId !== userId) continue;
      const before = JSON.stringify(replay.summary);
      let next = backfillSummaryFromPlayer(replay.summary, replay.player);
      const startedAt = normalizeTimestamp(next.startedAt) ?? repairTimestamp(next.startedAt);
      if (startedAt !== next.startedAt) {
        next = { ...next, startedAt };
      }
      if (typeof next.damageDealt === "number") {
        next = { ...next, damageDealt: Math.round(next.damageDealt) };
      }
      if (typeof next.damageTaken === "number") {
        next = { ...next, damageTaken: Math.round(next.damageTaken) };
      }
      if (!next.parseTier) next = { ...next, parseTier: "basic" };
      if (!next.deepParseStatus) {
        next = {
          ...next,
          deepParseStatus: next.status === "parsed" ? "available" : "none",
        };
      }
      replay.summary = next;
      if (JSON.stringify(replay.summary) !== before) {
        repaired += 1;
        this.syncReplay(replay);
      }
    }
    if (repaired > 0) this.write(db);
    return repaired;
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
    this.syncReplay(replay);
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
    this.syncUsage(userId, db.deepAnalyzeUsage[userId]!);
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

function repairTimestamp(value: string | number | null | undefined): string | number | null | undefined {
  if (value == null) return value;
  if (typeof value === "number") {
    if (value > 1e14) return new Date(Math.round(value / 1000)).toISOString();
    if (value > 1e11) return new Date(value).toISOString();
    if (value > 1e9) return new Date(Math.round(value * 1000)).toISOString();
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return repairTimestamp(Number(value));
  }
  return value;
}
