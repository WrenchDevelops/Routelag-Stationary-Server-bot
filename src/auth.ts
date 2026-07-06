import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  testerId: string;
  inviteCode: string;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createToken(inviteCode: string, secret: string): { token: string; testerId: string } {
  const testerId = stableTesterId(inviteCode);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      testerId,
      inviteCode,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
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

function stableTesterId(inviteCode: string): string {
  const digest = createHash("sha256")
    .update(inviteCode.trim().toUpperCase())
    .digest("hex")
    .slice(0, 24);
  return `tester_${digest}`;
}
