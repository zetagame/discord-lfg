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
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
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
    const names = [...new Set(input.split(",").map((name) => name.trim()).filter(Boolean))];
    if (!names.length) throw new Error("Choose at least one game.");
    return Promise.all(names.map((name) => this.resolveOne(guildId, name, createdByUserId)));
  }

  async deleteCustomGame(guildId: string, gameId: string, actorId: string, canManageGuild: boolean): Promise<Game> {
    const game = await this.db.prepare(`
      SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
      FROM games
      WHERE id = ? AND guild_id = ? AND provider_id IS NULL AND deleted_at IS NULL
    `).bind(gameId, guildId).first<Game>();
    if (!game) throw new Error("That custom game no longer exists.");
    if (!canManageGuild && game.createdByUserId !== actorId) throw new Error("You can only delete custom games you added.");
    await this.db.prepare("UPDATE games SET deleted_at = ? WHERE id = ? AND guild_id = ?")
      .bind(new Date().toISOString(), gameId, guildId).run();
    return game;
  }

  private async resolveOne(guildId: string, name: string, createdByUserId?: string): Promise<Game> {
    const found = await this.db
      .prepare(`SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
        FROM games WHERE guild_id = ? AND name = ? AND deleted_at IS NULL`)
      .bind(guildId, name)
      .first<Game>();
    if (found) return found;

    const external = (await this.provider.search(name)).find((game) => game.name.toLowerCase() === name.toLowerCase());
    const deleted = await this.db.prepare(`
      SELECT id FROM games WHERE guild_id = ? AND name = ? AND deleted_at IS NOT NULL
    `).bind(guildId, external?.name ?? name).first<{ id: string }>();
    if (deleted) {
      await this.db.prepare(`
        UPDATE games
        SET provider_id = ?, cover_url = ?, created_by_user_id = ?, deleted_at = NULL
        WHERE id = ?
      `).bind(external?.providerId ?? null, external?.coverUrl ?? null, external ? null : createdByUserId ?? null, deleted.id).run();
      return (await this.db.prepare(`
        SELECT id, name, provider_id AS providerId, cover_url AS coverUrl, created_by_user_id AS createdByUserId
        FROM games WHERE id = ?
      `).bind(deleted.id).first<Game>())!;
    }

    const game = {
      id: crypto.randomUUID(),
      name: external?.name ?? name,
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
    if (name.toLowerCase() !== stored.name.toLowerCase()) await this.db.prepare("INSERT OR IGNORE INTO game_aliases (guild_id, alias, game_id) VALUES (?, ?, ?)")
      .bind(guildId, name, stored.id).run();
    return stored;
  }
}
