export type ReplayJobStatus =
  | "local_found"
  | "queued"
  | "uploading"
  | "uploaded"
  | "osirion_pending"
  | "osirion_complete"
  | "fetching_match_data"
  | "parsed"
  | "failed";

export interface ReplayJob {
  id: string;
  userId: string;
  inviteCode: string;
  fileName: string;
  fileHash: string;
  fileSizeBytes: number;
  status: ReplayJobStatus;
  provider: "osirion";
  providerTrackingId?: string;
  providerMatchId?: string;
  replayId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  parsedAt?: string;
  lastCheckedAt?: string;
}

export interface PathGenKeyMoment {
  id: string;
  type: string;
  timestampSeconds: number;
  title: string;
  description?: string;
  importance?: "low" | "medium" | "high" | string;
  thumbnailUrl?: string;
}

export interface PathGenReplaySummary {
  id: string;
  userId: string;
  jobId: string;
  fileName: string;
  fileHash: string;
  status: "parsing" | "parsed" | "failed";
  mode?: string | null;
  playlist?: string | null;
  region?: string | null;
  startedAt?: string | number | null;
  durationSeconds?: number | null;
  placement?: number | null;
  eliminations?: number | null;
  assists?: number | null;
  damageDealt?: number | null;
  damageTaken?: number | null;
  accuracy?: number | null;
  materialsFarmed?: number | null;
  distanceTraveled?: number | null;
  thumbnailUrl?: string | null;
  createdAt: string;
  parsedAt?: string | null;
}

export interface PathGenReplayDetail {
  summary: PathGenReplaySummary;
  player?: unknown;
  match?: unknown;
  stats?: Record<string, unknown>;
  timeline?: unknown[];
  keyMoments: PathGenKeyMoment[];
  fights?: unknown[];
  eliminations?: unknown[];
  deaths?: unknown[];
  damageEvents?: unknown[];
  inventoryTimeline?: unknown[];
  rotations?: unknown[];
  rawProviderMetadata?: unknown;
}
