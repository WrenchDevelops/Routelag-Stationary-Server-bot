import type { PathGenConfig } from "../config.js";

export interface OsirionSubmitResult {
  provider: "osirion";
  trackingId: string;
}

export interface OsirionUploadStatus {
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | string;
  matchId?: string;
  error?: string;
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

  async fetchMatch(matchId: string): Promise<unknown> {
    const client = await this.client();
    const info = await client.getMatchInfo(matchId);
    const players = await client.getMatchPlayers(matchId, { type: "all" });
    const weapons = await client.getMatchWeapons(matchId);
    const eventTypes = [
      "eliminationEvents",
      "knockedDownEvents",
      "reviveEvents",
      "rebootEvents",
      "safeZoneUpdateEvents",
      "stormSurgeUpdateEvents",
      "playerInventoryUpdateEvents",
      "healthUpdateEvents",
      "shieldUpdateEvents",
      "overshieldUpdateEvents",
      "pingUpdateEvents",
      "framerateUpdateEvents",
      "buildEvents",
      "buildEditEvents",
      "buildDestroyEvents",
      "harvestWoodEvents",
      "harvestBrickEvents",
      "harvestMetalEvents",
      "fireWeaponEvents",
      "pickupItemEvents",
    ];
    const events = await client.getMatchEvents(matchId, eventTypes);
    return { info, players, weapons, events };
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
    return new ClientCtor(this.config.osirionApiKey, this.config.osirionApiBaseUrl || undefined);
  }
}
