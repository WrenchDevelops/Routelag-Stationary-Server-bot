import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  testerId: string;
  inviteCode: string;
  /** Verified Clerk subject — required for production PathGen sessions. */
  clerkUserId?: string;
  exp: number;
  iat?: number;
}

export const DEFAULT_PATHGEN_TOKEN_TTL_SEC = 60 * 60 * 2; // 2 hours

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createToken(
  inviteCode: string,
  secret: string,
  options?: { clerkUserId?: string; ttlSec?: number },
): { token: string; testerId: string } {
  const clerkUserId = options?.clerkUserId?.trim();
  // Prefer Clerk identity so every signed-in Zer0 user gets a stable PathGen row.
  const testerId = clerkUserId ? stableClerkTesterId(clerkUserId) : stableTesterId(inviteCode);
  const now = Math.floor(Date.now() / 1000);
  const ttl = options?.ttlSec ?? DEFAULT_PATHGEN_TOKEN_TTL_SEC;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      testerId,
      inviteCode,
      ...(clerkUserId ? { clerkUserId } : {}),
      iat: now,
      exp: now + ttl,
    } satisfies TokenClaims),
  );
  const body = `${header}.${payload}`;
  return { testerId, token: `${body}.${sign(body, secret)}` };
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(body, secret);
  const actual = parts[2];
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) return null;

  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims;
    if (!claims.testerId || !claims.inviteCode || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stableTesterId(inviteCode: string): string {
  const digest = createHash("sha256")
    .update(inviteCode.trim().toUpperCase())
    .digest("hex")
    .slice(0, 24);
  return `tester_${digest}`;
}

export function stableClerkTesterId(clerkUserId: string): string {
  const digest = createHash("sha256")
    .update(`clerk:${clerkUserId.trim()}`)
    .digest("hex")
    .slice(0, 24);
  return `tester_${digest}`;
}
