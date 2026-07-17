import type { PathGenConfig } from "../config.js";

export interface OsirionSubmitResult {
  provider: "osirion";
  trackingId: string;
}

export interface OsirionUploadStatus {
  status: number | string;
  matchId?: string;
  error?: string;
}

export type NormalizedOsirionUploadStatus =
  | { phase: "pending" }
  | { phase: "complete"; matchId: string }
  | { phase: "failed"; error?: string };

const DEFAULT_OSIRION_API_HOST = "https://api.osirion.gg";

/**
 * Resolve the Osirion API host. Misconfigured values (website URL, docs, Railway app)
 * return HTML and surface as `Unexpected token < in JSON at position 0`.
 */
export function resolveOsirionApiHost(configured?: string): string {
  const trimmed = (configured ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_OSIRION_API_HOST;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const looksLikeApi =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.startsWith("api.") ||
      host.includes("api.osirion");
    if (!looksLikeApi) return DEFAULT_OSIRION_API_HOST;
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_OSIRION_API_HOST;
  }
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const body = await response.text();
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error(`Osirion ${label} returned an empty body (${response.status}).`);
  }
  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype")) {
    throw new Error(
      `Osirion ${label} returned HTML instead of JSON (${response.status}). Check OSIRION_API_BASE_URL.`,
    );
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(
      `Osirion ${label} returned non-JSON (${response.status}): ${trimmed.slice(0, 160)}`,
    );
  }
}

/** Osirion v2 returns protobuf enum values (0–4), not legacy string names. */
export function normalizeUploadStatus(raw: OsirionUploadStatus): NormalizedOsirionUploadStatus {
  const matchId = coerceMatchId(raw);
  const statusKey = String(raw?.status ?? "").toUpperCase();

  const isFailed =
    raw?.status === 3 || statusKey === "3" || statusKey === "FAILED" || statusKey === "STATUS_FAILED";
  if (isFailed) {
    return { phase: "failed", error: typeof raw?.error === "string" ? raw.error : undefined };
  }

  const isComplete =
    raw?.status === 2 ||
    raw?.status === 4 ||
    statusKey === "2" ||
    statusKey === "4" ||
    statusKey === "COMPLETE" ||
    statusKey === "STATUS_COMPLETE" ||
    statusKey === "DUPLICATE" ||
    statusKey === "STATUS_DUPLICATE";

  if (isComplete && matchId) {
    return { phase: "complete", matchId };
  }

  return { phase: "pending" };
}

function coerceMatchId(raw: OsirionUploadStatus | null | undefined): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidates = [raw.matchId, (raw as { match_id?: string }).match_id];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Defensively unwrap nested / alternate Osirion status payloads.
 * Handles SDK quirks where getUploadStatus may return a bare enum, a nested
 * `{ status: UploadStatus }`, or a flat `{ status, matchId }` body.
 */
export function coerceUploadStatusPayload(raw: unknown): OsirionUploadStatus {
  if (typeof raw === "number" || typeof raw === "string") {
    return { status: raw };
  }
  if (!raw || typeof raw !== "object") {
    return { status: 0 };
  }

  const record = raw as Record<string, unknown>;

  // Flat UploadStatus: { status, matchId?, error? }
  if ("status" in record) {
    const nestedStatus = record.status;
    // Nested wrapper: { status: { status, matchId } }
    if (nestedStatus && typeof nestedStatus === "object" && !Array.isArray(nestedStatus)) {
      const nested = nestedStatus as Record<string, unknown>;
      if ("status" in nested || "matchId" in nested || "match_id" in nested) {
        return coerceUploadStatusPayload(nested);
      }
    }

    return {
      status: record.status as number | string,
      matchId:
        (typeof record.matchId === "string" && record.matchId) ||
        (typeof record.match_id === "string" && record.match_id) ||
        undefined,
      error: typeof record.error === "string" ? record.error : undefined,
    };
  }

  for (const key of ["uploadStatus", "data", "result", "body"]) {
    const nested = record[key];
    if (nested != null) {
      return coerceUploadStatusPayload(nested);
    }
  }

  return { status: 0 };
}

/** Normalize getMatchPlayers payloads across SDK/API shapes (array, wrappers, nested). */
export function normalizePlayersList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => unwrapPlayer(item))
      .filter((item): item is Record<string, unknown> => item != null);
  }
  if (!raw || typeof raw !== "object") return [];

  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.players)) return normalizePlayersList(record.players);
  if (Array.isArray(record.playerStats)) return normalizePlayersList(record.playerStats);
  if (Array.isArray(record.playerStatsWrappers)) {
    return normalizePlayersList(
      (record.playerStatsWrappers as unknown[]).map((wrapper) => {
        if (wrapper && typeof wrapper === "object" && "playerStats" in wrapper) {
          return (wrapper as { playerStats?: unknown }).playerStats;
        }
        return wrapper;
      }),
    );
  }
  return [];
}

function unwrapPlayer(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.playerStats && typeof record.playerStats === "object") {
    return record.playerStats as Record<string, unknown>;
  }
  return record;
}

export function pickReplayOwner(
  players: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return (
    players.find((item) => item?.isReplayOwner === true) ??
    players.find((item) => item?.isSessionOwner === true) ??
    players[0]
  );
}

export class OsirionClient {
  constructor(private readonly config: PathGenConfig) {}

  async submitReplayFile(filePath: string): Promise<OsirionSubmitResult> {
    const client = await this.client();
    const trackingId = await client.uploadReplay(filePath);
    return { provider: "osirion", trackingId: String(trackingId) };
  }

  /**
   * Prefer the SDK (same host/auth path as upload). @osirion/api@2 returns the full
   * UploadStatus object including matchId. Fall back to raw HTTP with a validated host.
   */
  async getUploadStatus(trackingId: string): Promise<OsirionUploadStatus> {
    try {
      const client = await this.client();
      const payload = await client.getUploadStatus(trackingId);
      return coerceUploadStatusPayload(payload);
    } catch (sdkError) {
      try {
        return await this.getUploadStatusRaw(trackingId);
      } catch {
        throw sdkError instanceof Error
          ? sdkError
          : new Error("Osirion upload status request failed.");
      }
    }
  }

  private async getUploadStatusRaw(trackingId: string): Promise<OsirionUploadStatus> {
    const apiKey = this.config.osirionApiKey;
    if (!apiKey) throw new Error("OSIRION_API_KEY is not configured.");

    const host = resolveOsirionApiHost(this.config.osirionApiBaseUrl);
    const url = `${host}/fortnite/v1/uploads/status?trackingId=${encodeURIComponent(trackingId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "@osirion-api/2.0.1",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Osirion upload status failed (${response.status}): ${body || response.statusText}`,
      );
    }

    return coerceUploadStatusPayload(await readJsonResponse(response, "upload status"));
  }

  async fetchBasicMatch(matchId: string, playersOnly = false): Promise<unknown> {
    const client = await this.client();
    const playersPromise = this.fetchPlayers(client, matchId);
    const infoPromise = playersOnly
      ? Promise.resolve(null)
      : client.getMatchInfo(matchId).catch(() => null);

    const [playersRaw, info] = await Promise.all([playersPromise, infoPromise]);
    const players = normalizePlayersList(playersRaw);
    const owner = pickReplayOwner(players);

    const resolvedInfo =
      info && typeof info === "object"
        ? { ...info, matchId: (info as { matchId?: string }).matchId ?? matchId }
        : owner
          ? {
              matchId,
              gameMode: owner.gameMode ?? null,
              startTimestamp: owner.startTimestamp,
              endTimestamp: owner.endTimestamp,
              lengthMs: lengthMsFromOwner(owner),
              region: owner.matchmakingRegion ?? null,
            }
          : { matchId };

    return { info: resolvedInfo, players, weapons: [], events: {} };
  }

  async fetchDeepMatchData(matchId: string, eventTypes: string[]): Promise<unknown> {
    const client = await this.client();
    const weapons = await client.getMatchWeapons(matchId);
    const zoneStats = await client.getMatchPlayerZoneStats(matchId);
    const events =
      eventTypes.length > 0
        ? await client.getMatchEvents(matchId, eventTypes as [string, ...string[]])
        : {};
    return { weapons, zoneStats, events };
  }

  private async fetchPlayers(client: any, matchId: string): Promise<unknown> {
    try {
      const fromSdk = await client.getMatchPlayers(matchId, { type: "all" });
      const normalized = normalizePlayersList(fromSdk);
      if (normalized.length > 0) return normalized;
    } catch {
      // Fall through to raw HTTP.
    }
    return this.fetchPlayersRaw(matchId);
  }

  private async fetchPlayersRaw(matchId: string): Promise<Record<string, unknown>[]> {
    const apiKey = this.config.osirionApiKey;
    if (!apiKey) throw new Error("OSIRION_API_KEY is not configured.");

    const host = resolveOsirionApiHost(this.config.osirionApiBaseUrl);
    const url = `${host}/fortnite/v1/matches/${encodeURIComponent(matchId)}/players`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "@osirion-api/2.0.1",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Osirion match players failed (${response.status}): ${body || response.statusText}`,
      );
    }
    return normalizePlayersList(await readJsonResponse(response, "match players"));
  }

  private async client(): Promise<any> {
    if (!this.config.osirionApiKey) {
      throw new Error("OSIRION_API_KEY is not configured.");
    }
    const module = await import("@osirion/api");
    const ClientCtor = (module as any).OsirionClient;
    if (!ClientCtor) {
      throw new Error("@osirion/api did not expose OsirionClient.");
    }
    return new ClientCtor(this.config.osirionApiKey);
  }
}

function lengthMsFromOwner(owner: Record<string, unknown>): number | undefined {
  const alive = numberish(owner.timeAlive ?? owner.timeAliveSeconds);
  if (alive != null) return Math.round(alive * 1000);
  return undefined;
}

function numberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
