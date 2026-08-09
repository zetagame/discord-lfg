import type { Game } from "./types";

const IGDB_TIMEOUT_MS = 1500;

export interface GameProvider {
  search(query: string): Promise<Game[]>;
}

export class IgdbProvider implements GameProvider {
  constructor(private readonly clientId?: string, private readonly clientSecret?: string) {}
  private token?: { value: string; expiresAt: number };

  async search(query: string): Promise<Game[]> {
    if (!this.clientId || !this.clientSecret || !query.trim()) return [];
    try {
      const access_token = await this.accessToken();
      if (!access_token) return [];
      const response = await fetchWithTimeout("https://api.igdb.com/v4/games", {
        method: "POST",
        headers: {
          "Client-ID": this.clientId,
          Authorization: "Bearer " + access_token,
        },
        body: `search "${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"; fields id,name,cover.url; limit 20;`,
      });
      if (!response.ok) return [];
      const games = (await response.json()) as Array<{ id: number; name: string; cover?: { url: string } }>;
      return games.map((game) => ({ id: `igdb:${game.id}`, name: game.name, providerId: String(game.id), coverUrl: game.cover?.url?.replace(/^\/\//, "https://") }));
    } catch {
      return [];
    }
  }

  private async accessToken(): Promise<string | undefined> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetchWithTimeout("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, grant_type: "client_credentials" }),
    });
    if (!response.ok) return undefined;
    const token = await response.json() as { access_token: string; expires_in?: number };
    this.token = { value: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
    return token.access_token;
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IGDB_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export class GameSelectionService {
  constructor(private readonly db: D1Database, private readonly provider: GameProvider) {}

  async search(guildId: string, query: string): Promise<Game[]> {
    const cached = await this.db
      .prepare(`SELECT DISTINCT games.id, games.name, games.provider_id AS providerId, games.cover_url AS coverUrl,
          games.created_by_user_id AS createdByUserId
        FROM games LEFT JOIN game_aliases ON game_aliases.game_id = games.id
        WHERE games.guild_id = ? AND games.deleted_at IS NULL
          AND (games.name LIKE ? OR game_aliases.alias LIKE ?)
        ORDER BY games.name LIMIT 20`)
      .bind(guildId, `%${query}%`, `%${query}%`)
      .all<Game>();
    const external = cached.results.length >= 20 ? [] : await this.provider.search(query);
    return [...cached.results, ...external.filter((game) => !cached.results.some((cachedGame) => cachedGame.name.toLowerCase() === game.name.toLowerCase()))].slice(0, 20);
  }

  async resolve(guildId: string, input: string, createdByUserId?: string): Promise<Game[]> {
    const name = input.trim();
    if (!name) throw new Error("Choose a game.");
    return [await this.resolveOne(guildId, name, createdByUserId)];
  }

  async deleteCustomGame(
    guildId: string,
    gameId: string,
    actorId: string,
    canManageGuild: boolean,
  ): Promise<{ game: Game; collected: boolean }> {
    const game = await this.db.prepare(`
      SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
      FROM games
      WHERE id = ? AND guild_id = ? AND provider_id IS NULL AND deleted_at IS NULL
    `).bind(gameId, guildId).first<Game>();
    if (!game) throw new Error("That custom game no longer exists.");
    if (!canManageGuild && game.createdByUserId !== actorId) throw new Error("You can only delete custom games you added.");
    await this.db.prepare("UPDATE games SET deleted_at = ? WHERE id = ? AND guild_id = ?")
      .bind(new Date().toISOString(), gameId, guildId).run();
    return { game, collected: await collectDeletedCustomGame(this.db, gameId) };
  }

  private async resolveOne(guildId: string, name: string, createdByUserId?: string): Promise<Game> {
    const found = await this.db
      .prepare(`SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
        FROM games WHERE guild_id = ? AND name = ? AND deleted_at IS NULL`)
      .bind(guildId, name)
      .first<Game>();
    if (found) return found;

    const external = (await this.provider.search(name)).find((game) => game.name.toLowerCase() === name.toLowerCase());
    const storedName = external?.name ?? name;
    const deleted = await this.db.prepare(`
      SELECT id FROM games WHERE guild_id = ? AND name = ? AND deleted_at IS NOT NULL
    `).bind(guildId, storedName).first<{ id: string }>();
    if (deleted && !await collectDeletedCustomGame(this.db, deleted.id)) {
      throw new Error(`**${storedName}** was removed but is still attached to an active group or event. Try again after it finishes.`);
    }

    const game = {
      id: crypto.randomUUID(),
      name: storedName,
      providerId: external?.providerId,
      coverUrl: external?.coverUrl,
      createdByUserId: external ? undefined : createdByUserId,
    };
    await this.db
      .prepare("INSERT OR IGNORE INTO games (id, guild_id, name, provider_id, cover_url, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(game.id, guildId, game.name, game.providerId ?? null, game.coverUrl ?? null, game.createdByUserId ?? null)
      .run();
    const stored = (await this.db.prepare(`
      SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
      FROM games WHERE guild_id = ? AND name = ? AND deleted_at IS NULL
    `).bind(guildId, game.name).first<Game>())!;
    if (name.toLowerCase() !== stored.name.toLowerCase()) {
      await this.db.prepare("INSERT OR IGNORE INTO game_aliases (guild_id, alias, game_id) VALUES (?, ?, ?)")
        .bind(guildId, name, stored.id).run();
    }
    return stored;
  }
}

async function hasOpenGroupMembership(db: D1Database, gameId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM game_groups JOIN group_members ON group_members.group_id = game_groups.id
    WHERE game_groups.game_id = ? AND julianday(group_members.expires_at) > julianday('now')
    LIMIT 1
  `).bind(gameId).first<{ found: number }>();
  return Boolean(row);
}

async function hasGroupPanel(db: D1Database, gameId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM game_groups WHERE game_id = ? AND discord_message_id IS NOT NULL LIMIT 1")
    .bind(gameId).first<{ found: number }>();
  return Boolean(row);
}

async function hasActiveEvent(db: D1Database, gameId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM event_games
    JOIN events ON events.id = event_games.event_id
    LEFT JOIN event_triggers ON event_triggers.event_id = events.id
    WHERE event_games.game_id = ? AND events.deleted_at IS NULL AND (
      (events.starts_at IS NOT NULL AND julianday(events.starts_at) > julianday('now'))
      OR (events.starts_at IS NULL AND (event_triggers.fired_at IS NULL OR event_triggers.event_id IS NULL))
    )
    LIMIT 1
  `).bind(gameId).first<{ found: number }>();
  return Boolean(row);
}

export async function collectDeletedCustomGame(db: D1Database, gameId: string): Promise<boolean> {
  const deleted = await db.prepare("SELECT id FROM games WHERE id = ? AND provider_id IS NULL AND deleted_at IS NOT NULL")
    .bind(gameId).first<{ id: string }>();
  if (!deleted) return false;
  if (await hasOpenGroupMembership(db, gameId)) return false;
  if (await hasGroupPanel(db, gameId)) return false;
  if (await hasActiveEvent(db, gameId)) return false;

  await db.batch([
    db.prepare("DELETE FROM group_members WHERE group_id IN (SELECT id FROM game_groups WHERE game_id = ?)").bind(gameId),
    db.prepare("DELETE FROM lfg_overlap_pairs WHERE game_id = ?").bind(gameId),
    db.prepare("DELETE FROM lfg_games WHERE game_id = ?").bind(gameId),
    db.prepare(`DELETE FROM event_game_votes WHERE game_id = ? AND event_id IN (
      SELECT events.id FROM events LEFT JOIN event_triggers ON event_triggers.event_id = events.id
      WHERE events.deleted_at IS NOT NULL
        OR (events.starts_at IS NOT NULL AND julianday(events.starts_at) <= julianday('now'))
        OR (events.starts_at IS NULL AND event_triggers.fired_at IS NOT NULL)
    )`).bind(gameId),
    db.prepare(`DELETE FROM event_games WHERE game_id = ? AND event_id IN (
      SELECT events.id FROM events LEFT JOIN event_triggers ON event_triggers.event_id = events.id
      WHERE events.deleted_at IS NOT NULL
        OR (events.starts_at IS NOT NULL AND julianday(events.starts_at) <= julianday('now'))
        OR (events.starts_at IS NULL AND event_triggers.fired_at IS NOT NULL)
    )`).bind(gameId),
    db.prepare("DELETE FROM game_groups WHERE game_id = ?").bind(gameId),
  ]);

  const references = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM lfg_games WHERE game_id = ?) +
      (SELECT COUNT(*) FROM event_games WHERE game_id = ?) +
      (SELECT COUNT(*) FROM event_game_votes WHERE game_id = ?) +
      (SELECT COUNT(*) FROM game_groups WHERE game_id = ?) AS count
  `).bind(gameId, gameId, gameId, gameId).first<{ count: number }>();
  if ((references?.count ?? 0) > 0) return false;

  await db.batch([
    db.prepare("DELETE FROM game_aliases WHERE game_id = ?").bind(gameId),
    db.prepare("DELETE FROM games WHERE id = ? AND provider_id IS NULL AND deleted_at IS NOT NULL").bind(gameId),
  ]);
  return true;
}

export async function collectDeletedCustomGames(db: D1Database): Promise<void> {
  const games = await db.prepare("SELECT id FROM games WHERE provider_id IS NULL AND deleted_at IS NOT NULL").all<{ id: string }>();
  for (const game of games.results) await collectDeletedCustomGame(db, game.id);
}
