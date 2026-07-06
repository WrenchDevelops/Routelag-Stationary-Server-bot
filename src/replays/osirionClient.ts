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

/** Osirion v2 returns protobuf enum values (0–4), not legacy string names. */
export function normalizeUploadStatus(raw: OsirionUploadStatus): NormalizedOsirionUploadStatus {
  const matchId = raw.matchId?.trim() || undefined;
  const statusKey = String(raw.status).toUpperCase();

  const isFailed =
    raw.status === 3 || statusKey === "3" || statusKey === "FAILED" || statusKey === "STATUS_FAILED";
  if (isFailed) {
    return { phase: "failed", error: raw.error };
  }

  const isComplete =
    raw.status === 2 ||
    raw.status === 4 ||
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

export class OsirionClient {
  constructor(private readonly config: PathGenConfig) {}

  async submitReplayFile(filePath: string): Promise<OsirionSubmitResult> {
    const client = await this.client();
    const trackingId = await client.uploadReplay(filePath);
    return { provider: "osirion", trackingId: String(trackingId) };
  }

  async getUploadStatus(trackingId: string): Promise<OsirionUploadStatus> {
    const client = await this.client();
    return (await client.getUploadStatus(trackingId)) as OsirionUploadStatus;
  }

  async fetchBasicMatch(matchId: string, playersOnly = true): Promise<unknown> {
    const client = await this.client();
    const players = await client.getMatchPlayers(matchId, { type: "all" });
    if (playersOnly) {
      const owner =
        players.find((item: any) => item?.isReplayOwner) ??
        players.find((item: any) => item?.isSessionOwner) ??
        players[0];
      const info = owner
        ? {
            matchId,
            gameMode: null,
            startTimestamp: owner.startTimestamp,
            endTimestamp: owner.endTimestamp,
            lengthMs:
              typeof owner.timeAlive === "number"
                ? owner.timeAlive * 1000
                : undefined,
          }
        : { matchId };
      return { info, players, weapons: [], events: {} };
    }
    const info = await client.getMatchInfo(matchId);
    return { info, players, weapons: [], events: {} };
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
