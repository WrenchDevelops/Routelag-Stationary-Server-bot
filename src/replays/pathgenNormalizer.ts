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
    mode: stringOrNull(info.gameMode ?? info.mode),
    playlist: stringOrNull(info.playlist ?? info.playlistName),
    region: stringOrNull(player.matchmakingRegion ?? info.region),
    startedAt: info.startTimestamp ?? info.startedAt ?? null,
    durationSeconds: durationSeconds(info),
    placement: numberOrNull(player.placement),
    eliminations: numberOrNull(player.eliminations),
    assists: numberOrNull(player.assists),
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
    deaths: eventList(match?.events, "deathEvents"),
    damageEvents: eventList(match?.events, "damageEvents"),
    inventoryTimeline: eventList(match?.events, "playerInventoryUpdateEvents"),
    rawProviderMetadata: {
      provider: "osirion",
      matchId: replayId,
    },
  };
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
