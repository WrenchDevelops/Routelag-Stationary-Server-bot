import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PathGenConfig {
  host: string;
  port: number;
  authSecret: string;
  inviteCodes: Set<string>;
  serviceApiKey: string;
  osirionApiBaseUrl: string;
  osirionApiKey: string;
  osirionWebhookSecret: string;
  replayUploadMaxMb: number;
  replayStorageDir: string;
  replayDataFile: string;
  replayPollIntervalMs: number;
  replayFirstPollDelayMs: number;
  replayMaxStatusPolls: number;
  /** Players-only basic fetch skips getMatchInfo (~10 credits saved per replay). */
  basicParsePlayersOnly: boolean;
  deepAnalyzeMonthlyLimit: number;
  deepAnalyzeDailyLimit: number;
  deepAnalyzeCooldownMs: number;
}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(overrides: Partial<PathGenConfig> = {}): PathGenConfig {
  const replayStorageDir = resolve(env("REPLAY_STORAGE_DIR", "data/replays/uploads"));
  const replayDataFile = resolve(env("REPLAY_DATA_FILE", "data/pathgen-db.json"));

  mkdirSync(replayStorageDir, { recursive: true });
  mkdirSync(dirname(replayDataFile), { recursive: true });

  const inviteList = env("PATHGEN_INVITE_CODES", "ROUTELAG-BETA,WRENCH-TEST")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  return {
    host: env("PATHGEN_HOST", "0.0.0.0"),
    port: Number(env("PORT", env("PATHGEN_PORT", "8788"))),
    authSecret: env("PATHGEN_AUTH_SECRET", "dev-pathgen-secret"),
    inviteCodes: new Set(inviteList),
    serviceApiKey: env("PATHGEN_SERVICE_API_KEY", ""),
    osirionApiBaseUrl: env("OSIRION_API_BASE_URL", ""),
    osirionApiKey: env("OSIRION_API_KEY", ""),
    osirionWebhookSecret: env("OSIRION_WEBHOOK_SECRET", ""),
    replayUploadMaxMb: Number(env("REPLAY_UPLOAD_MAX_MB", "250")),
    replayStorageDir,
    replayDataFile,
    replayPollIntervalMs: Number(env("REPLAY_POLL_INTERVAL_MS", "90000")),
    replayFirstPollDelayMs: Number(env("REPLAY_FIRST_POLL_DELAY_MS", "60000")),
    replayMaxStatusPolls: Number(env("REPLAY_MAX_STATUS_POLLS", "18")),
    basicParsePlayersOnly: env("BASIC_PARSE_PLAYERS_ONLY", "true") !== "false",
    deepAnalyzeMonthlyLimit: Number(env("DEEP_ANALYZE_MONTHLY_LIMIT", "10")),
    deepAnalyzeDailyLimit: Number(env("DEEP_ANALYZE_DAILY_LIMIT", "3")),
    deepAnalyzeCooldownMs: Number(env("DEEP_ANALYZE_COOLDOWN_MS", "120000")),
    ...overrides,
  };
}
