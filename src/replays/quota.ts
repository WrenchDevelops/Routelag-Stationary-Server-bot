import type { PathGenConfig } from "../config.js";

export interface DeepAnalyzeQuota {
  used: number;
  limit: number;
  remaining: number;
  monthKey: string;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
  dayKey: string;
  cooldownMs: number;
  cooldownRemainingMs: number;
  canTrigger: boolean;
}

export function buildDeepAnalyzeQuota(
  userId: string,
  usage: {
    monthKey: string;
    monthCount: number;
    dayKey: string;
    dayCount: number;
    lastDeepAnalyzeAt?: string;
  } | undefined,
  config: PathGenConfig,
  now = Date.now(),
): DeepAnalyzeQuota {
  const monthKey = currentMonthKey(now);
  const dayKey = currentDayKey(now);
  const monthUsed = usage?.monthKey === monthKey ? usage.monthCount : 0;
  const dailyUsed = usage?.dayKey === dayKey ? usage.dayCount : 0;
  const lastAt = usage?.lastDeepAnalyzeAt ? Date.parse(usage.lastDeepAnalyzeAt) : 0;
  const cooldownRemainingMs =
    lastAt > 0 ? Math.max(config.deepAnalyzeCooldownMs - (now - lastAt), 0) : 0;

  const monthlyRemaining = Math.max(config.deepAnalyzeMonthlyLimit - monthUsed, 0);
  const dailyRemaining = Math.max(config.deepAnalyzeDailyLimit - dailyUsed, 0);
  const remaining = Math.min(monthlyRemaining, dailyRemaining);

  return {
    used: monthUsed,
    limit: config.deepAnalyzeMonthlyLimit,
    remaining,
    monthKey,
    dailyUsed,
    dailyLimit: config.deepAnalyzeDailyLimit,
    dailyRemaining,
    dayKey,
    cooldownMs: config.deepAnalyzeCooldownMs,
    cooldownRemainingMs,
    canTrigger: remaining > 0 && cooldownRemainingMs === 0,
  };
}

function currentMonthKey(now: number): string {
  const date = new Date(now);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentDayKey(now: number): string {
  const date = new Date(now);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function deepAnalyzeBlockReason(quota: DeepAnalyzeQuota): string | null {
  if (quota.remaining <= 0) {
    if (quota.dailyRemaining <= 0) {
      return `Daily deep analyze limit reached (${quota.dailyLimit}/day). Basic summaries stay unlimited.`;
    }
    return `Monthly deep analyze limit reached (${quota.limit}/month). Basic summaries stay unlimited.`;
  }
  if (quota.cooldownRemainingMs > 0) {
    const seconds = Math.ceil(quota.cooldownRemainingMs / 1000);
    return `Please wait ${seconds}s before running another deep analyze.`;
  }
  return null;
}
