import { createHash, randomBytes } from "node:crypto";

const DISCORD_AUTHORIZE_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_USER_URL = "https://discord.com/api/users/@me";
const DEFAULT_SCOPES = "identify";

export interface DiscordOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface DiscordUserInfo {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
}

export interface PendingDiscordLink {
  testerId: string;
  inviteCode: string;
  createdAt: number;
  expiresAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingLinks = new Map<string, PendingDiscordLink>();

function prunePending(): void {
  const now = Date.now();
  for (const [state, entry] of pendingLinks) {
    if (entry.expiresAt < now) pendingLinks.delete(state);
  }
}

export function createDiscordLinkStateValue(): string {
  return randomBytes(24).toString("hex");
}

export function discordLinkExpiresAt(now = Date.now()): number {
  return now + PENDING_TTL_MS;
}

export function rememberDiscordLinkState(
  state: string,
  testerId: string,
  inviteCode: string,
  expiresAt = discordLinkExpiresAt(),
): void {
  prunePending();
  pendingLinks.set(state, {
    testerId,
    inviteCode,
    createdAt: Date.now(),
    expiresAt,
  });
}

export function consumeMemoryDiscordLinkState(state: string): PendingDiscordLink | null {
  prunePending();
  const entry = pendingLinks.get(state) ?? null;
  if (entry) pendingLinks.delete(state);
  return entry;
}

export function buildDiscordAuthorizeUrl(config: DiscordOAuthConfig, state: string): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DEFAULT_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeDiscordAuthorizationCode(
  config: DiscordOAuthConfig,
  code: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    throw new Error(`Discord token exchange failed: ${detail}`);
  }

  return json as unknown as DiscordTokenResponse;
}

export async function fetchDiscordUserInfo(accessToken: string): Promise<DiscordUserInfo> {
  const response = await fetch(DISCORD_USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Discord userInfo returned invalid JSON");
  }
  if (!response.ok) {
    const detail =
      typeof json.message === "string"
        ? json.message
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${response.status}`;
    throw new Error(`Discord userInfo failed: ${detail}`);
  }

  const id = typeof json.id === "string" ? json.id : "";
  const username = typeof json.username === "string" ? json.username : "";
  if (!id || !username) throw new Error("Discord userInfo missing id or username");

  return {
    id,
    username,
    global_name: typeof json.global_name === "string" ? json.global_name : null,
    discriminator: typeof json.discriminator === "string" ? json.discriminator : undefined,
  };
}

export function resolveDiscordDisplayName(user: DiscordUserInfo): string {
  const globalName = user.global_name?.trim();
  if (globalName) return globalName;
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

export function fingerprintClientId(clientId: string): string {
  return createHash("sha256").update(clientId).digest("hex").slice(0, 8);
}
