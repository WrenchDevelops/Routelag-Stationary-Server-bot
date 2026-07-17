import { normalizePlayersList, pickReplayOwner } from "./osirionClient.js";
import type { PathGenKeyMoment, PathGenReplayDetail, PathGenReplaySummary } from "./types.js";

export function normalizeOsirionToPathGen(input: {
  jobId: string;
  userId: string;
  fileName: string;
  fileHash: string;
  createdAt: string;
  match: any;
}): PathGenReplayDetail {
  const { jobId, userId, fileName, fileHash, createdAt, match } = input;
  const info = match?.info ?? {};
  const players = normalizePlayersList(match?.players);
  const player = (pickReplayOwner(players) ?? {}) as Record<string, unknown>;

  const combat = extractCombatStats(player);
  const replayId = String(info.matchId ?? info.id ?? player.matchId ?? `pathgen_${jobId}`);
  const parsedAt = new Date().toISOString();
  const timeAliveSeconds = numberOrNull(
    player.timeAlive ?? player.timeAliveSeconds ?? player.aliveTimeSeconds,
  );
  const duration =
    durationSeconds(info) ??
    (timeAliveSeconds != null ? Math.round(timeAliveSeconds) : null);

  const summary: PathGenReplaySummary = {
    id: replayId,
    userId,
    jobId,
    fileName,
    fileHash,
    status: "parsed",
    parseTier: "basic",
    deepParseStatus: "available",
    mode: stringOrNull(info.gameMode ?? info.mode ?? info.mnemonic ?? player.gameMode),
    playlist: stringOrNull(info.playlist ?? info.playlistName ?? info.mnemonic),
    region: stringOrNull(player.matchmakingRegion ?? info.region),
    startedAt: normalizeTimestamp(info.startTimestamp ?? info.startedAt ?? player.startTimestamp),
    durationSeconds: duration,
    ...combat,
    timeAliveSeconds: timeAliveSeconds != null ? Math.round(timeAliveSeconds) : null,
    thumbnailUrl: stringOrNull(info.thumbnailUrl),
    createdAt,
    parsedAt,
  };

  return {
    summary,
    player,
    match: info,
    stats: { weapons: match?.weapons ?? [] },
    timeline: flattenEvents(match?.events),
    keyMoments: normalizeKeyMoments(match?.events),
    fights: [],
    eliminations: eventList(match?.events, "eliminationEvents"),
    deaths: eventList(match?.events, "knockedDownEvents"),
    damageEvents: [],
    inventoryTimeline: eventList(match?.events, "playerInventoryUpdateEvents"),
    zoneStats: [],
    rawProviderMetadata: {
      provider: "osirion",
      matchId: replayId,
    },
  };
}

export function cloneReplayForJob(
  source: PathGenReplayDetail,
  input: { jobId: string; fileName: string; fileHash: string; createdAt: string; userId?: string },
): PathGenReplayDetail {
  const parsedAt = new Date().toISOString();
  const summary = backfillSummaryFromPlayer(
    {
      ...source.summary,
      ...(input.userId ? { userId: input.userId } : {}),
      jobId: input.jobId,
      fileName: input.fileName,
      fileHash: input.fileHash,
      createdAt: input.createdAt,
      parsedAt,
      parseTier: source.summary.parseTier ?? "basic",
      deepParseStatus: source.summary.deepParseStatus ?? "available",
      startedAt: normalizeTimestamp(source.summary.startedAt),
      damageDealt: roundStat(source.summary.damageDealt ?? null),
      damageTaken: roundStat(source.summary.damageTaken ?? null),
    },
    source.player,
  );
  return {
    ...source,
    summary,
  };
}

export function mergeDeepParseIntoReplay(
  replay: PathGenReplayDetail,
  deep: { weapons?: unknown; zoneStats?: unknown; events?: any },
): PathGenReplayDetail {
  const events = deep.events ?? {};
  const parsedAt = new Date().toISOString();
  return {
    ...replay,
    summary: {
      ...replay.summary,
      parseTier: "deep",
      deepParseStatus: "parsed",
      deepParsedAt: parsedAt,
      deepParseError: null,
    },
    stats: {
      ...(replay.stats ?? {}),
      weapons: deep.weapons ?? [],
    },
    zoneStats: Array.isArray(deep.zoneStats) ? deep.zoneStats : [],
    eliminations: eventList(events, "eliminationEvents"),
    deaths: eventList(events, "knockedDownEvents"),
    inventoryTimeline: eventList(events, "playerInventoryUpdateEvents"),
    rotations: eventList(events, "safeZoneUpdateEvents"),
    timeline: flattenEvents(events),
    keyMoments: buildKeyMoments(events),
  };
}

/** Osirion timestamps are often microseconds since epoch. */
export function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() === String(asNumber)) {
      return normalizeTimestamp(asNumber);
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  // Microseconds (~1e15), milliseconds (~1e12), or seconds (~1e9).
  let ms = value;
  if (value > 1e14) ms = Math.round(value / 1000);
  else if (value < 1e11) ms = Math.round(value * 1000);

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildKeyMoments(events: any): PathGenKeyMoment[] {
  const explicit = normalizeKeyMoments(events);
  if (explicit.length) return explicit;

  const moments: PathGenKeyMoment[] = [];
  for (const [index, event] of eventList(events, "eliminationEvents").entries()) {
    const item = event as any;
    moments.push({
      id: `elim_${index}`,
      type: "elimination",
      timestampSeconds: timestampSeconds(item?.timestamp),
      title: item?.selfElimination ? "Eliminated" : "Elimination",
      description: item?.distance != null ? `${Math.round(item.distance)}m` : undefined,
      importance: "high",
    });
  }
  for (const [index, event] of eventList(events, "knockedDownEvents").entries()) {
    const item = event as any;
    moments.push({
      id: `knock_${index}`,
      type: "knocked",
      timestampSeconds: timestampSeconds(item?.timestamp),
      title: "Knocked down",
      importance: "medium",
    });
  }
  return moments.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

function timestampSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value > 1e14) return Math.round(value / 1_000_000);
  if (value > 1e11) return Math.round(value / 1000);
  return Math.round(value);
}

function durationSeconds(info: any): number | null {
  if (typeof info.lengthMs === "number") return Math.round(info.lengthMs / 1000);
  const start = normalizeTimestamp(info.startTimestamp ?? info.startedAt);
  const end = normalizeTimestamp(info.endTimestamp ?? info.endedAt);
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / 1000);
  }
  return numberOrNull(info.durationSeconds ?? info.duration);
}

function flattenEvents(events: any): unknown[] {
  if (!events || typeof events !== "object") return [];
  return Object.values(events).flatMap((value) => (Array.isArray(value) ? value : []));
}

function eventList(events: any, key: string): unknown[] {
  return Array.isArray(events?.[key]) ? events[key] : [];
}

function normalizeKeyMoments(events: any): PathGenKeyMoment[] {
  const explicit = eventList(events, "keyMoments");
  if (explicit.length) {
    return explicit.map((event: any, index) => ({
      id: String(event.id ?? `moment_${index}`),
      type: String(event.type ?? "moment"),
      timestampSeconds: numberOrNull(event.timestampSeconds ?? event.timeSeconds) ?? 0,
      title: String(event.title ?? "Replay moment"),
      description: stringOrNull(event.description) ?? undefined,
      importance: event.importance ?? event.severity ?? "medium",
      thumbnailUrl: stringOrNull(event.thumbnailUrl) ?? undefined,
    }));
  }
  return [];
}

/** Pull combat / movement stats from a raw Osirion player object. */
export function extractCombatStats(player: Record<string, unknown> | null | undefined): {
  placement: number | null;
  eliminations: number | null;
  assists: number | null;
  deaths: number | null;
  headshots: number | null;
  damageDealt: number | null;
  damageTaken: number | null;
  accuracy: number | null;
  materialsFarmed: number | null;
  distanceTraveled: number | null;
} {
  const p = player ?? {};
  const shots = numberOrNull(p.shots ?? p.totalShots) ?? 0;
  const hits = numberOrNull(p.hits ?? p.totalHits) ?? 0;
  const wood = numberOrNull(p.woodFarmed);
  const stone = numberOrNull(p.stoneFarmed);
  const metal = numberOrNull(p.metalFarmed);
  const materials =
    wood == null && stone == null && metal == null
      ? null
      : (wood ?? 0) + (stone ?? 0) + (metal ?? 0);
  const cm =
    (numberOrNull(p.distanceTraveledOnFoot) ?? 0) +
    (numberOrNull(p.distanceTraveledInVehicle) ?? 0) +
    (numberOrNull(p.distanceTraveledSkydiving) ?? 0);

  return {
    placement: numberOrNull(p.placement ?? p.teamPlacement ?? p.rank ?? p.placementRank),
    eliminations: numberOrNull(
      p.eliminations ?? p.kills ?? p.numKills ?? p.eliminationCount ?? p.humanElims,
    ),
    assists: numberOrNull(p.assists ?? p.assistCount),
    deaths: numberOrNull(p.deaths ?? p.deathCount),
    headshots: numberOrNull(p.headshots ?? p.headshotCount),
    damageDealt: roundStat(
      numberOrNull(
        p.damageToPlayers ??
          p.damageDone ??
          p.gameplaycueDamageToPlayers ??
          p.damage ??
          p.totalDamage ??
          p.damageDealt,
      ),
    ),
    damageTaken: roundStat(
      numberOrNull(
        p.damageTakenFromPlayers ??
          p.damageTaken ??
          p.damageReceived ??
          p.totalDamageTaken,
      ),
    ),
    accuracy: shots > 0 ? Math.round((hits / shots) * 100) : null,
    materialsFarmed: materials,
    distanceTraveled: cm > 0 ? roundStat(cm / 100) : null,
  };
}

/** Backfill null summary combat fields from the stored raw player blob. */
export function backfillSummaryFromPlayer(
  summary: PathGenReplaySummary,
  player: unknown,
): PathGenReplaySummary {
  const combat = extractCombatStats(
    player && typeof player === "object" ? (player as Record<string, unknown>) : null,
  );
  return {
    ...summary,
    placement: summary.placement ?? combat.placement,
    eliminations: summary.eliminations ?? combat.eliminations,
    assists: summary.assists ?? combat.assists,
    deaths: summary.deaths ?? combat.deaths,
    headshots: summary.headshots ?? combat.headshots,
    damageDealt: summary.damageDealt ?? combat.damageDealt,
    damageTaken: summary.damageTaken ?? combat.damageTaken,
    accuracy: summary.accuracy ?? combat.accuracy,
    materialsFarmed: summary.materialsFarmed ?? combat.materialsFarmed,
    distanceTraveled:
      summary.distanceTraveled != null && summary.distanceTraveled > 0
        ? normalizeDistanceMeters(summary.distanceTraveled, player)
        : (combat.distanceTraveled ?? normalizeDistanceMeters(summary.distanceTraveled, player)),
  };
}

function normalizeDistanceMeters(stored: number | null | undefined, player: unknown): number | null {
  if (stored != null && stored > 0 && stored < 50_000) return roundStat(stored);
  const p = (player && typeof player === "object" ? player : {}) as Record<string, unknown>;
  const cm =
    (numberOrNull(p.distanceTraveledOnFoot) ?? 0) +
    (numberOrNull(p.distanceTraveledInVehicle) ?? 0) +
    (numberOrNull(p.distanceTraveledSkydiving) ?? 0);
  if (cm > 0) return roundStat(cm / 100);
  return roundStat(stored ?? null);
}

function roundStat(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
