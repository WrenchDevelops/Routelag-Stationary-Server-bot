import type { SupabaseClient } from "@supabase/supabase-js";

import type { PathGenReplayDetail, ReplayJob, ReplayJobStatus } from "../replays/types.js";

type ReplayRow = {
  id: string;
  tester_id: string;
  clerk_user_id: string | null;
  job_id: string;
  file_name: string;
  file_hash: string;
  status: string;
  parse_tier: string;
  summary: unknown;
  detail: unknown;
  created_at: string;
  updated_at: string;
  parsed_at: string | null;
};

type JobRow = {
  id: string;
  tester_id: string;
  clerk_user_id: string | null;
  invite_code: string;
  file_name: string;
  file_hash: string;
  file_size_bytes: number;
  status: string;
  provider: string;
  provider_tracking_id: string | null;
  provider_match_id: string | null;
  replay_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  parsed_at: string | null;
  payload: unknown;
};

export class CloudDataSync {
  constructor(private readonly client: SupabaseClient | null) {}

  get enabled(): boolean {
    return Boolean(this.client);
  }

  private db(): SupabaseClient {
    if (!this.client) throw new Error("Supabase is not configured");
    return this.client;
  }

  async upsertReplayJob(job: ReplayJob, clerkUserId?: string | null): Promise<void> {
    if (!this.enabled) return;
    await this.ensureMinimalUser(job.userId, job.inviteCode, clerkUserId);
    const { error } = await this.db().from("pathgen_replay_jobs").upsert(
      {
        id: job.id,
        tester_id: job.userId,
        clerk_user_id: clerkUserId ?? null,
        invite_code: job.inviteCode,
        file_name: job.fileName,
        file_hash: job.fileHash,
        file_size_bytes: job.fileSizeBytes,
        status: job.status,
        provider: job.provider,
        provider_tracking_id: job.providerTrackingId ?? null,
        provider_match_id: job.providerMatchId ?? null,
        replay_id: job.replayId ?? null,
        error_code: job.errorCode ?? null,
        error_message: job.errorMessage ?? null,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        parsed_at: job.parsedAt ?? null,
        payload: {
          nextPollAt: job.nextPollAt ?? null,
          lastCheckedAt: job.lastCheckedAt ?? null,
          statusPollCount: job.statusPollCount ?? 0,
        },
      },
      { onConflict: "id" },
    );
    if (error) console.warn("[Supabase] upsertReplayJob failed:", error.message);
  }

  async upsertReplay(detail: PathGenReplayDetail, clerkUserId?: string | null): Promise<void> {
    if (!this.enabled) return;
    await this.ensureMinimalUser(detail.summary.userId, "", clerkUserId);
    const summary = detail.summary;
    // Persist full parsed JSON (never the .replay binary). Drop raw provider blob to keep rows lean.
    const { rawProviderMetadata: _raw, ...persisted } = detail;
    const { error } = await this.db().from("pathgen_replays").upsert(
      {
        id: summary.id,
        tester_id: summary.userId,
        clerk_user_id: clerkUserId ?? null,
        job_id: summary.jobId,
        file_name: summary.fileName,
        file_hash: summary.fileHash,
        status: summary.status,
        parse_tier: summary.parseTier,
        summary,
        detail: {
          version: 2,
          replay: persisted,
        },
        created_at: summary.createdAt,
        updated_at: new Date().toISOString(),
        parsed_at: summary.parsedAt ?? null,
      },
      { onConflict: "id" },
    );
    if (error) console.warn("[Supabase] upsertReplay failed:", error.message);
  }

  async listJobs(testerId: string, clerkUserId?: string | null): Promise<ReplayJob[]> {
    if (!this.enabled) return [];
    const rows = await this.selectOwnedRows<JobRow>("pathgen_replay_jobs", testerId, clerkUserId);
    return rows.map(rowToJob);
  }

  async getJob(jobId: string, testerId: string, clerkUserId?: string | null): Promise<ReplayJob | null> {
    if (!this.enabled) return null;
    const { data, error } = await this.db()
      .from("pathgen_replay_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    if (error) {
      console.warn("[Supabase] getJob failed:", error.message);
      return null;
    }
    if (!data) return null;
    const row = data as JobRow;
    if (!ownsRow(row.tester_id, row.clerk_user_id, testerId, clerkUserId)) return null;
    return rowToJob(row);
  }

  async findJobByHash(
    testerId: string,
    fileHash: string,
    clerkUserId?: string | null,
  ): Promise<ReplayJob | null> {
    if (!this.enabled) return null;
    const rows = await this.selectOwnedRows<JobRow>("pathgen_replay_jobs", testerId, clerkUserId, {
      eq: { file_hash: fileHash },
    });
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async listReplays(testerId: string, clerkUserId?: string | null): Promise<PathGenReplayDetail[]> {
    if (!this.enabled) return [];
    const rows = await this.selectOwnedRows<ReplayRow>("pathgen_replays", testerId, clerkUserId);
    return rows.map(rowToReplay).filter((item): item is PathGenReplayDetail => Boolean(item));
  }

  async getReplay(
    replayId: string,
    testerId: string,
    clerkUserId?: string | null,
  ): Promise<PathGenReplayDetail | null> {
    if (!this.enabled) return null;
    const { data, error } = await this.db()
      .from("pathgen_replays")
      .select("*")
      .eq("id", replayId)
      .maybeSingle();
    if (error) {
      console.warn("[Supabase] getReplay failed:", error.message);
      return null;
    }
    if (!data) return null;
    const row = data as ReplayRow;
    if (!ownsRow(row.tester_id, row.clerk_user_id, testerId, clerkUserId)) return null;
    return rowToReplay(row);
  }

  async findReplayByHash(
    testerId: string,
    fileHash: string,
    clerkUserId?: string | null,
  ): Promise<PathGenReplayDetail | null> {
    if (!this.enabled) return null;
    const rows = await this.selectOwnedRows<ReplayRow>("pathgen_replays", testerId, clerkUserId, {
      eq: { file_hash: fileHash },
    });
    return rows[0] ? rowToReplay(rows[0]) : null;
  }

  /** Move jobs/replays from a legacy tester id onto the current account id. */
  async migrateTesterOwnership(
    fromTesterId: string,
    toTesterId: string,
    clerkUserId?: string | null,
  ): Promise<number> {
    if (!this.enabled || !fromTesterId || fromTesterId === toTesterId) return 0;
    let moved = 0;
    const stamp = new Date().toISOString();
    const patch = {
      tester_id: toTesterId,
      clerk_user_id: clerkUserId ?? null,
      updated_at: stamp,
    };

    for (const table of ["pathgen_replay_jobs", "pathgen_replays"] as const) {
      const { data, error } = await this.db()
        .from(table)
        .update(patch)
        .eq("tester_id", fromTesterId)
        .select("id");
      if (error) {
        console.warn(`[Supabase] migrate ${table} failed:`, error.message);
        continue;
      }
      moved += data?.length ?? 0;
    }

    const { error: usageError } = await this.db()
      .from("pathgen_deep_analyze_usage")
      .update({ tester_id: toTesterId, updated_at: stamp })
      .eq("tester_id", fromTesterId);
    if (usageError && !/duplicate|unique|conflict/i.test(usageError.message)) {
      console.warn("[Supabase] migrate deep analyze usage failed:", usageError.message);
    }

    return moved;
  }

  async upsertDeepAnalyzeUsage(
    testerId: string,
    usage: {
      monthKey: string;
      monthCount: number;
      dayKey: string;
      dayCount: number;
      lastDeepAnalyzeAt?: string;
    },
  ): Promise<void> {
    if (!this.enabled) return;
    await this.ensureMinimalUser(testerId, "");
    const { error } = await this.db().from("pathgen_deep_analyze_usage").upsert(
      {
        tester_id: testerId,
        month_key: usage.monthKey,
        month_count: usage.monthCount,
        day_key: usage.dayKey,
        day_count: usage.dayCount,
        last_deep_analyze_at: usage.lastDeepAnalyzeAt ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tester_id" },
    );
    if (error) console.warn("[Supabase] upsertDeepAnalyzeUsage failed:", error.message);
  }

  async upsertRoutingSession(input: {
    sessionId: string;
    testerId: string;
    clerkUserId?: string | null;
    inviteCode?: string;
    nodeId: string;
    gameId?: string;
    serverName?: string;
    endpoint?: string;
    appVersion?: string;
    active: boolean;
    createdAt: string;
    endedAt?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.enabled) return;

    let nodeId = input.nodeId;
    let serverName = input.serverName ?? "";
    let endpoint = input.endpoint ?? "";
    let gameId = input.gameId ?? "fortnite";
    let appVersion = input.appVersion ?? "";
    let createdAt = input.createdAt;
    let meta = input.meta ?? {};

    if ((!input.active || nodeId === "unknown") && nodeId === "unknown") {
      const { data: existing } = await this.db()
        .from("routing_sessions")
        .select("*")
        .eq("session_id", input.sessionId)
        .maybeSingle();
      if (existing) {
        nodeId = String(existing.node_id || nodeId);
        serverName = String(existing.server_name || serverName);
        endpoint = String(existing.endpoint || endpoint);
        gameId = String(existing.game_id || gameId);
        appVersion = String(existing.app_version || appVersion);
        createdAt = String(existing.created_at || createdAt);
        meta = {
          ...((existing.meta && typeof existing.meta === "object" ? existing.meta : {}) as Record<
            string,
            unknown
          >),
          ...meta,
        };
      }
    }

    const { error } = await this.db().from("routing_sessions").upsert(
      {
        session_id: input.sessionId,
        tester_id: input.testerId,
        clerk_user_id: input.clerkUserId ?? null,
        invite_code: input.inviteCode ?? "",
        node_id: nodeId,
        game_id: gameId,
        server_name: serverName,
        endpoint,
        app_version: appVersion,
        active: input.active,
        created_at: createdAt,
        ended_at: input.endedAt ?? null,
        meta,
      },
      { onConflict: "session_id" },
    );
    if (error) console.warn("[Supabase] upsertRoutingSession failed:", error.message);
  }

  private async selectOwnedRows<T extends { tester_id: string; clerk_user_id: string | null }>(
    table: "pathgen_replay_jobs" | "pathgen_replays",
    testerId: string,
    clerkUserId?: string | null,
    filters?: { eq?: Record<string, string> },
  ): Promise<T[]> {
    let query = this.db().from(table).select("*");
    if (clerkUserId) {
      query = query.or(`tester_id.eq.${testerId},clerk_user_id.eq.${clerkUserId}`);
    } else {
      query = query.eq("tester_id", testerId);
    }
    if (filters?.eq) {
      for (const [key, value] of Object.entries(filters.eq)) {
        query = query.eq(key, value);
      }
    }
    const { data, error } = await query;
    if (error) {
      console.warn(`[Supabase] list ${table} failed:`, error.message);
      return [];
    }
    return (data ?? []) as T[];
  }

  private async ensureMinimalUser(
    testerId: string,
    inviteCode: string,
    clerkUserId?: string | null,
  ): Promise<void> {
    const stamp = new Date().toISOString();
    const row: Record<string, unknown> = {
      tester_id: testerId,
      updated_at: stamp,
      last_login_at: stamp,
    };
    if (inviteCode) row.invite_code = inviteCode;
    if (clerkUserId) row.clerk_user_id = clerkUserId;

    const { error } = await this.db()
      .from("pathgen_users")
      .upsert(row, { onConflict: "tester_id", ignoreDuplicates: false });
    // Ignore conflicts from partial upserts; row just needs to exist for FKs.
    if (error && !/duplicate|unique/i.test(error.message)) {
      console.warn("[Supabase] ensureMinimalUser failed:", error.message);
    }
  }
}

function ownsRow(
  rowTesterId: string,
  rowClerkUserId: string | null,
  testerId: string,
  clerkUserId?: string | null,
): boolean {
  if (rowTesterId === testerId) return true;
  if (clerkUserId && rowClerkUserId === clerkUserId) return true;
  return false;
}

function rowToJob(row: JobRow): ReplayJob {
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    userId: row.tester_id,
    inviteCode: row.invite_code || "",
    fileName: row.file_name,
    fileHash: row.file_hash,
    fileSizeBytes: row.file_size_bytes,
    status: row.status as ReplayJobStatus,
    provider: (row.provider as "osirion") || "osirion",
    providerTrackingId: row.provider_tracking_id ?? undefined,
    providerMatchId: row.provider_match_id ?? undefined,
    replayId: row.replay_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedAt: row.parsed_at ?? undefined,
    nextPollAt: typeof payload.nextPollAt === "string" ? payload.nextPollAt : undefined,
    lastCheckedAt: typeof payload.lastCheckedAt === "string" ? payload.lastCheckedAt : undefined,
    statusPollCount: typeof payload.statusPollCount === "number" ? payload.statusPollCount : 0,
  };
}

function rowToReplay(row: ReplayRow): PathGenReplayDetail | null {
  const detailBag =
    row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {};
  const nested =
    detailBag.replay && typeof detailBag.replay === "object"
      ? (detailBag.replay as PathGenReplayDetail)
      : null;
  const summaryFromColumn =
    row.summary && typeof row.summary === "object"
      ? (row.summary as PathGenReplayDetail["summary"])
      : null;

  if (nested?.summary) {
    return {
      ...nested,
      summary: {
        ...nested.summary,
        userId: row.tester_id,
      },
    };
  }

  // Legacy rows that only stored keyMoments/stats/zoneStats.
  if (!summaryFromColumn) return null;
  return {
    summary: {
      ...summaryFromColumn,
      userId: row.tester_id,
      id: summaryFromColumn.id || row.id,
      jobId: summaryFromColumn.jobId || row.job_id,
      fileName: summaryFromColumn.fileName || row.file_name,
      fileHash: summaryFromColumn.fileHash || row.file_hash,
      status: summaryFromColumn.status || (row.status as PathGenReplayDetail["summary"]["status"]),
      parseTier:
        summaryFromColumn.parseTier ||
        (row.parse_tier as PathGenReplayDetail["summary"]["parseTier"]) ||
        "basic",
      deepParseStatus: summaryFromColumn.deepParseStatus || "none",
      createdAt: summaryFromColumn.createdAt || row.created_at,
      parsedAt: summaryFromColumn.parsedAt ?? row.parsed_at,
    },
    keyMoments: Array.isArray(detailBag.keyMoments)
      ? (detailBag.keyMoments as PathGenReplayDetail["keyMoments"])
      : [],
    stats:
      detailBag.stats && typeof detailBag.stats === "object"
        ? (detailBag.stats as Record<string, unknown>)
        : undefined,
    zoneStats: Array.isArray(detailBag.zoneStats) ? detailBag.zoneStats : undefined,
  };
}
