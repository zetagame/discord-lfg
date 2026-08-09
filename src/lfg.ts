import type { Game } from "./types";

export type LfgState = "active" | "paused" | "stopped" | "expired";

export interface LfgRecord {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  expiresAt: string;
  pausedAt?: string;
  stoppedAt?: string;
  discordMessageId?: string;
  finalizedAt?: string;
}

export interface LfgSnapshot {
  lfg: LfgRecord;
  games: Game[];
  counts: Map<string, number>;
}

export function lfgState(lfg: LfgRecord, now = Date.now()): LfgState {
  if (lfg.stoppedAt) return "stopped";
  if (new Date(lfg.expiresAt).getTime() <= now) return "expired";
  if (lfg.pausedAt) return "paused";
  return "active";
}

export async function loadLfg(db: D1Database, guildId: string, lfgId: string): Promise<LfgRecord | undefined> {
  const row = await db.prepare(`
    SELECT id, guild_id AS guildId, channel_id AS channelId, author_id AS authorId,
      expires_at AS expiresAt, paused_at AS pausedAt, stopped_at AS stoppedAt,
      discord_message_id AS discordMessageId, finalized_at AS finalizedAt
    FROM lfgs WHERE id = ? AND guild_id = ?
  `).bind(lfgId, guildId).first<LfgRecord>();
  return row ?? undefined;
}

export async function loadLfgGames(db: D1Database, lfgId: string): Promise<Game[]> {
  const result = await db.prepare(`
    SELECT games.id, games.name, games.provider_id AS providerId, games.cover_url AS coverUrl,
      games.created_by_user_id AS createdByUserId, games.deleted_at AS deletedAt
    FROM lfg_games JOIN games ON games.id = lfg_games.game_id
    WHERE lfg_games.lfg_id = ? ORDER BY games.name
  `).bind(lfgId).all<Game>();
  return result.results;
}

export async function activeUsersByGame(
  db: D1Database,
  guildId: string,
  gameIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!gameIds.length) return result;
  const placeholders = gameIds.map(() => "?").join(",");
  const rows = await db.prepare(`
    SELECT lfg_games.game_id AS gameId, lfgs.author_id AS authorId
    FROM lfgs JOIN lfg_games ON lfg_games.lfg_id = lfgs.id
    WHERE lfgs.guild_id = ? AND lfg_games.game_id IN (${placeholders})
      AND lfgs.stopped_at IS NULL AND lfgs.paused_at IS NULL
      AND julianday(lfgs.expires_at) > julianday('now')
    GROUP BY lfg_games.game_id, lfgs.author_id
  `).bind(guildId, ...gameIds).all<{ gameId: string; authorId: string }>();
  for (const row of rows.results) {
    const users = result.get(row.gameId) ?? [];
    users.push(row.authorId);
    result.set(row.gameId, users);
  }
  return result;
}

export async function lfgSnapshot(db: D1Database, guildId: string, lfgId: string): Promise<LfgSnapshot | undefined> {
  const lfg = await loadLfg(db, guildId, lfgId);
  if (!lfg) return undefined;
  const games = await loadLfgGames(db, lfgId);
  const active = await activeUsersByGame(db, guildId, games.map((game) => game.id));
  return {
    lfg,
    games,
    counts: new Map(games.map((game) => [game.id, active.get(game.id)?.length ?? 0])),
  };
}

export async function createLfg(
  db: D1Database,
  guildId: string,
  channelId: string,
  authorId: string,
  games: Game[],
  expiresAt: Date,
): Promise<{ id: string; newlyOverlappingGameIds: string[]; recipients: string[] }> {
  const gameIds = games.map((game) => game.id);
  const before = await activeUsersByGame(db, guildId, gameIds);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO lfgs (id, guild_id, channel_id, author_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, guildId, channelId, authorId, expiresAt.toISOString(), createdAt),
    ...gameIds.map((gameId) => db.prepare("INSERT INTO lfg_games (lfg_id, game_id) VALUES (?, ?)").bind(id, gameId)),
  ]);
  const newlyOverlappingGameIds = gameIds.filter((gameId) => {
    const users = before.get(gameId) ?? [];
    return !users.includes(authorId) && users.some((userId) => userId !== authorId);
  });
  const recipients = [...new Set(newlyOverlappingGameIds.flatMap((gameId) => before.get(gameId) ?? []).filter((userId) => userId !== authorId))];
  return { id, newlyOverlappingGameIds, recipients };
}

export async function mutateLfg(
  db: D1Database,
  guildId: string,
  lfgId: string,
  actorId: string,
  action: "pause" | "resume" | "stop",
): Promise<{ snapshot: LfgSnapshot; changedGameIds: string[]; newlyOverlappingGameIds: string[]; recipients: string[] }> {
  const lfg = await loadLfg(db, guildId, lfgId);
  if (!lfg) throw new Error("That LFG no longer exists.");
  if (lfg.authorId !== actorId) throw new Error("Only the person who created this LFG can change it.");
  const state = lfgState(lfg);
  if (state === "expired") throw new Error("This LFG window has already expired.");
  if (state === "stopped") throw new Error("This LFG has already stopped.");
  if (action === "pause" && state !== "active") throw new Error("This LFG is already paused.");
  if (action === "resume" && state !== "paused") throw new Error("This LFG is not paused.");

  const games = await loadLfgGames(db, lfgId);
  const gameIds = games.map((game) => game.id);
  const before = await activeUsersByGame(db, guildId, gameIds);
  const now = new Date().toISOString();
  if (action === "pause") {
    await db.prepare("UPDATE lfgs SET paused_at = ? WHERE id = ? AND guild_id = ? AND stopped_at IS NULL")
      .bind(now, lfgId, guildId).run();
  } else if (action === "resume") {
    await db.prepare("UPDATE lfgs SET paused_at = NULL WHERE id = ? AND guild_id = ? AND stopped_at IS NULL")
      .bind(lfgId, guildId).run();
  } else {
    await db.prepare("UPDATE lfgs SET stopped_at = ?, paused_at = NULL, finalized_at = ? WHERE id = ? AND guild_id = ? AND stopped_at IS NULL")
      .bind(now, now, lfgId, guildId).run();
  }

  const after = await activeUsersByGame(db, guildId, gameIds);
  const changedGameIds = gameIds.filter((gameId) => (before.get(gameId)?.length ?? 0) !== (after.get(gameId)?.length ?? 0));
  const newlyOverlappingGameIds = action === "resume"
    ? gameIds.filter((gameId) => {
      const beforeUsers = before.get(gameId) ?? [];
      const afterUsers = after.get(gameId) ?? [];
      return !beforeUsers.includes(actorId) && afterUsers.includes(actorId) && afterUsers.some((userId) => userId !== actorId);
    })
    : [];
  const recipients = [...new Set(newlyOverlappingGameIds.flatMap((gameId) => (after.get(gameId) ?? []).filter((userId) => userId !== actorId)))];
  const snapshot = await lfgSnapshot(db, guildId, lfgId);
  if (!snapshot) throw new Error("Could not reload this LFG.");
  return { snapshot, changedGameIds, newlyOverlappingGameIds, recipients };
}

export async function saveLfgMessageId(db: D1Database, lfgId: string, messageId: string): Promise<void> {
  await db.prepare("UPDATE lfgs SET discord_message_id = ? WHERE id = ?").bind(messageId, lfgId).run();
}

export async function refreshableLfgsForGames(db: D1Database, guildId: string, gameIds: string[]): Promise<LfgRecord[]> {
  if (!gameIds.length) return [];
  const placeholders = gameIds.map(() => "?").join(",");
  const rows = await db.prepare(`
    SELECT DISTINCT lfgs.id, lfgs.guild_id AS guildId, lfgs.channel_id AS channelId, lfgs.author_id AS authorId,
      lfgs.expires_at AS expiresAt, lfgs.paused_at AS pausedAt, lfgs.stopped_at AS stoppedAt,
      lfgs.discord_message_id AS discordMessageId, lfgs.finalized_at AS finalizedAt
    FROM lfgs JOIN lfg_games ON lfg_games.lfg_id = lfgs.id
    WHERE lfgs.guild_id = ? AND lfg_games.game_id IN (${placeholders})
      AND lfgs.discord_message_id IS NOT NULL
      AND lfgs.stopped_at IS NULL AND julianday(lfgs.expires_at) > julianday('now')
  `).bind(guildId, ...gameIds).all<LfgRecord>();
  return rows.results;
}

export async function claimExpiredLfgs(db: D1Database): Promise<Array<{ lfg: LfgRecord; gameIds: string[] }>> {
  const rows = await db.prepare(`
    SELECT id, guild_id AS guildId, channel_id AS channelId, author_id AS authorId,
      expires_at AS expiresAt, paused_at AS pausedAt, stopped_at AS stoppedAt,
      discord_message_id AS discordMessageId, finalized_at AS finalizedAt
    FROM lfgs
    WHERE stopped_at IS NULL AND finalized_at IS NULL AND julianday(expires_at) <= julianday('now')
  `).all<LfgRecord>();
  const now = new Date().toISOString();
  const claimed: Array<{ lfg: LfgRecord; gameIds: string[] }> = [];
  for (const lfg of rows.results) {
    const update = await db.prepare("UPDATE lfgs SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL")
      .bind(now, lfg.id).run();
    if (!update.meta.changes) continue;
    const games = await loadLfgGames(db, lfg.id);
    claimed.push({ lfg: { ...lfg, finalizedAt: now }, gameIds: games.map((game) => game.id) });
  }
  return claimed;
}
