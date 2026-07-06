import type { PathGenKeyMoment, PathGenReplayDetail } from "./types.js";

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
  const players = Array.isArray(match?.players) ? match.players : [];
  const player =
    players.find((item: any) => item?.isReplayOwner) ??
    players.find((item: any) => item?.isSessionOwner) ??
    players[0] ??
    {};

  const shots = numberOrNull(player.shots) ?? 0;
  const hits = numberOrNull(player.hits) ?? 0;
  const replayId = String(info.matchId ?? info.id ?? `pathgen_${jobId}`);
  const parsedAt = new Date().toISOString();

  const summary = {
    id: replayId,
    userId,
    jobId,
    fileName,
    fileHash,
    status: "parsed" as const,
    parseTier: "basic" as const,
    deepParseStatus: "available" as const,
    mode: stringOrNull(info.gameMode ?? info.mode),
    playlist: stringOrNull(info.playlist ?? info.playlistName),
    region: stringOrNull(player.matchmakingRegion ?? info.region),
    startedAt: info.startTimestamp ?? info.startedAt ?? null,
    durationSeconds: durationSeconds(info),
    placement: numberOrNull(player.placement),
    eliminations: numberOrNull(player.eliminations),
    assists: numberOrNull(player.assists),
    deaths: numberOrNull(player.deaths),
    headshots: numberOrNull(player.headshots),
    damageDealt: numberOrNull(player.damageToPlayers ?? player.damageDone),
    damageTaken: numberOrNull(player.damageTakenFromPlayers ?? player.damageTaken),
    accuracy: shots > 0 ? Math.round((hits / shots) * 100) : null,
    materialsFarmed:
      (numberOrNull(player.woodFarmed) ?? 0) +
      (numberOrNull(player.stoneFarmed) ?? 0) +
      (numberOrNull(player.metalFarmed) ?? 0),
    distanceTraveled:
      (numberOrNull(player.distanceTraveledOnFoot) ?? 0) +
      (numberOrNull(player.distanceTraveledInVehicle) ?? 0) +
      (numberOrNull(player.distanceTraveledSkydiving) ?? 0),
    timeAliveSeconds: numberOrNull(player.timeAlive),
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
  input: { jobId: string; fileName: string; fileHash: string; createdAt: string },
): PathGenReplayDetail {
  const parsedAt = new Date().toISOString();
  return {
    ...source,
    summary: {
      ...source.summary,
      jobId: input.jobId,
      fileName: input.fileName,
      fileHash: input.fileHash,
      createdAt: input.createdAt,
      parsedAt,
      parseTier: source.summary.parseTier ?? "basic",
      deepParseStatus: source.summary.deepParseStatus ?? "available",
    },
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
  return value > 1_000_000_000_000 ? Math.round(value / 1000) : Math.round(value);
}

function durationSeconds(info: any): number | null {
  if (typeof info.lengthMs === "number") return Math.round(info.lengthMs / 1000);
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
