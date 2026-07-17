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
  firebaseProjectId: string;
  firebaseCredentialsPath: string;
  firebaseCredentialsJson: string;
  firebaseDisabled: boolean;
  epicClientId: string;
  epicClientSecret: string;
  /** Must match a Redirect URL registered on the Epic client exactly. */
  epicRedirectUri: string;
}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(overrides: Partial<PathGenConfig> = {}): PathGenConfig {
  const replayStorageDir = resolve(env("REPLAY_STORAGE_DIR", "data/replays/uploads"));
  const replayDataFile = resolve(env("REPLAY_DATA_FILE", "data/pathgen-db.json"));

  mkdirSync(replayStorageDir, { recursive: true });
  mkdirSync(dirname(replayDataFile), { recursive: true });

  const inviteList = env(
    "PATHGEN_INVITE_CODES",
    "ROUTELAG-BETA,SIGMA-BETA,DECKZEE-BETA,WRENCH-BETA,SIGMA-DALLAS,WRENCH-TEST,BETA-SA-001,BETA-SA-002,BETA-SA-003,BETA-SA-004,BETA-SA-005",
  )
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  // Always allow these PathGen logins (emails or codes), even when Railway
  // PATHGEN_INVITE_CODES overrides the default list above.
  const alwaysAllowed = ["benderaiden826@gmail.com"];

  return {
    host: env("PATHGEN_HOST", "0.0.0.0"),
    port: Number(env("PORT", env("PATHGEN_PORT", "8788"))),
    authSecret: env("PATHGEN_AUTH_SECRET", "dev-pathgen-secret"),
    inviteCodes: new Set([...inviteList, ...alwaysAllowed]),
    serviceApiKey: env("PATHGEN_SERVICE_API_KEY", ""),
    osirionApiBaseUrl: env("OSIRION_API_BASE_URL", ""),
    osirionApiKey: env("OSIRION_API_KEY", ""),
    osirionWebhookSecret: env("OSIRION_WEBHOOK_SECRET", ""),
    replayUploadMaxMb: Number(env("REPLAY_UPLOAD_MAX_MB", "250")),
    replayStorageDir,
    replayDataFile,
    // Defaults tuned for reliable UX without burning Osirion credits:
    // first check ~15s after upload, then every 30s, up to ~20 minutes.
    replayPollIntervalMs: Number(env("REPLAY_POLL_INTERVAL_MS", "30000")),
    replayFirstPollDelayMs: Number(env("REPLAY_FIRST_POLL_DELAY_MS", "15000")),
    replayMaxStatusPolls: Number(env("REPLAY_MAX_STATUS_POLLS", "40")),
    // Players-only skips getMatchInfo (~10 credits) — owner fields cover mode/duration.
    basicParsePlayersOnly: env("BASIC_PARSE_PLAYERS_ONLY", "true") !== "false",
    deepAnalyzeMonthlyLimit: Number(env("DEEP_ANALYZE_MONTHLY_LIMIT", "10")),
    deepAnalyzeDailyLimit: Number(env("DEEP_ANALYZE_DAILY_LIMIT", "3")),
    deepAnalyzeCooldownMs: Number(env("DEEP_ANALYZE_COOLDOWN_MS", "120000")),
    firebaseProjectId: env("FIREBASE_PROJECT_ID", "lunory-61a2a"),
    firebaseCredentialsPath: env(
      "GOOGLE_APPLICATION_CREDENTIALS",
      env("FIREBASE_CREDENTIALS_PATH", "secrets/firebase-adminsdk.json"),
    ),
    firebaseCredentialsJson: env("FIREBASE_SERVICE_ACCOUNT_JSON"),
    firebaseDisabled: env("FIREBASE_DISABLED", "false") === "true",
    epicClientId: env("EPIC_CLIENT_ID"),
    epicClientSecret: env("EPIC_CLIENT_SECRET"),
    // Zer0 must land on PathGen — not fortnitepathtopro (that site's state store is separate).
    // Register this exact Redirect URL on the Epic client.
    epicRedirectUri: resolveEpicRedirectUri(),
    ...overrides,
  };
}

const PATHGEN_EPIC_CALLBACK =
  "https://routelag-stationary-server-bot-production.up.railway.app/api/epic/callback";

function resolveEpicRedirectUri(): string {
  const configured = env("EPIC_REDIRECT_URI", PATHGEN_EPIC_CALLBACK);
  // Old Railway env still pointed at fortnitepathtopro.com, which rejects PathGen states.
  if (/fortnitepathtopro\.com/i.test(configured)) {
    return PATHGEN_EPIC_CALLBACK;
  }
  return configured;
}
