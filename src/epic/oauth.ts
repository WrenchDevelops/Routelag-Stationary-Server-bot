import { createHash, randomBytes } from "node:crypto";

const EPIC_AUTHORIZE_URL = "https://www.epicgames.com/id/authorize";
const EPIC_TOKEN_URL = "https://api.epicgames.dev/epic/oauth/v2/token";
const EPIC_USERINFO_URL = "https://api.epicgames.dev/epic/oauth/v2/userInfo";
const DEFAULT_SCOPES = "basic_profile";

export interface EpicOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface EpicTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  account_id?: string;
}

export interface EpicUserInfo {
  sub: string;
  preferred_username?: string;
  name?: string;
  email?: string;
}

export interface PendingEpicLink {
  testerId: string;
  inviteCode: string;
  createdAt: number;
  expiresAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingLinks = new Map<string, PendingEpicLink>();

function prunePending(): void {
  const now = Date.now();
  for (const [state, entry] of pendingLinks) {
    if (entry.expiresAt < now) pendingLinks.delete(state);
  }
}

export function createEpicLinkStateValue(): string {
  return randomBytes(24).toString("hex");
}

export function epicLinkExpiresAt(now = Date.now()): number {
  return now + PENDING_TTL_MS;
}

/** Fast in-memory state so /api/epic/start never blocks on Firestore. */
export function rememberEpicLinkState(
  state: string,
  testerId: string,
  inviteCode: string,
  expiresAt = epicLinkExpiresAt(),
): void {
  prunePending();
  pendingLinks.set(state, {
    testerId,
    inviteCode,
    createdAt: Date.now(),
    expiresAt,
  });
}

export function consumeMemoryEpicLinkState(state: string): PendingEpicLink | null {
  prunePending();
  const entry = pendingLinks.get(state) ?? null;
  if (entry) pendingLinks.delete(state);
  return entry;
}

export function buildEpicAuthorizeUrl(config: EpicOAuthConfig, state: string): string {
  const url = new URL(EPIC_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DEFAULT_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  // Epic expects the raw secret in Basic auth (do not URI-encode + / =).
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

export async function exchangeEpicAuthorizationCode(
  config: EpicOAuthConfig,
  code: string,
): Promise<EpicTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    scope: DEFAULT_SCOPES,
  });

  const response = await fetch(EPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
    },
    body,
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: "invalid_json", raw: text.slice(0, 200) };
  }

  if (!response.ok) {
    const detail =
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new Error(`Epic token exchange failed: ${detail}`);
  }

  return json as unknown as EpicTokenResponse;
}

export async function fetchEpicUserInfo(accessToken: string): Promise<EpicUserInfo> {
  const response = await fetch(EPIC_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Epic userInfo returned invalid JSON");
  }
  if (!response.ok) {
    const detail =
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new Error(`Epic userInfo failed: ${detail}`);
  }
  const sub = typeof json.sub === "string" ? json.sub : "";
  if (!sub) throw new Error("Epic userInfo missing account id (sub)");
  return {
    sub,
    preferred_username:
      typeof json.preferred_username === "string" ? json.preferred_username : undefined,
    name: typeof json.name === "string" ? json.name : undefined,
    email: typeof json.email === "string" ? json.email : undefined,
  };
}

export function resolveEpicDisplayName(user: EpicUserInfo, token: EpicTokenResponse): string {
  return (
    user.preferred_username?.trim() ||
    user.name?.trim() ||
    token.account_id?.trim() ||
    user.sub
  );
}

/** Stable fingerprint for logs — never log raw secrets or tokens. */
export function fingerprintClientId(clientId: string): string {
  return createHash("sha256").update(clientId).digest("hex").slice(0, 8);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
