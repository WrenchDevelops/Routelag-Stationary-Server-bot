import type { SupabaseClient } from "@supabase/supabase-js";

import type { PathGenReplayDetail, ReplayJob } from "../replays/types.js";

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
          keyMoments: detail.keyMoments,
          stats: detail.stats ?? null,
          zoneStats: detail.zoneStats ?? null,
        },
        created_at: summary.createdAt,
        updated_at: new Date().toISOString(),
        parsed_at: summary.parsedAt ?? null,
      },
      { onConflict: "id" },
    );
    if (error) console.warn("[Supabase] upsertReplay failed:", error.message);
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

  private async ensureMinimalUser(
    testerId: string,
    inviteCode: string,
    clerkUserId?: string | null,
  ): Promise<void> {
    const { error } = await this.db().from("pathgen_users").upsert(
      {
        tester_id: testerId,
        invite_code: inviteCode || "",
        clerk_user_id: clerkUserId ?? null,
        updated_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      },
      { onConflict: "tester_id", ignoreDuplicates: false },
    );
    // Ignore conflicts from partial upserts; row just needs to exist for FKs.
    if (error && !/duplicate|unique/i.test(error.message)) {
      console.warn("[Supabase] ensureMinimalUser failed:", error.message);
    }
  }
}
