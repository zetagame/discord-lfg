import type { Env, Game } from "./types";

export interface GameProvider {
  search(query: string): Promise<Game[]>;
}

export class IgdbProvider implements GameProvider {
  constructor(private readonly clientId?: string, private readonly clientSecret?: string) {}

  async search(query: string): Promise<Game[]> {
    if (!this.clientId || !this.clientSecret || !query.trim()) return [];
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!tokenResponse.ok) return [];
    const { access_token } = (await tokenResponse.json()) as { access_token: string };
    const response = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": this.clientId,
        Authorization: "Bearer " + access_token,
      },
      body: `search "${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"; fields id,name; limit 20;`,
    });
    if (!response.ok) return [];
    const games = (await response.json()) as Array<{ id: number; name: string }>;
    return games.map((game) => ({ id: `igdb:${game.id}`, name: game.name, providerId: String(game.id) }));
  }
}

export class GameSelectionService {
  constructor(private readonly db: D1Database, private readonly provider: GameProvider) {}

  async search(guildId: string, query: string): Promise<Game[]> {
    const cached = await this.db
      .prepare("SELECT id, name, provider_id AS providerId FROM games WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 20")
      .bind(guildId, `%${query}%`)
      .all<Game>();
    if (cached.results.length) return cached.results;
    return this.provider.search(query);
  }

  async resolve(guildId: string, input: string): Promise<Game[]> {
    const names = [...new Set(input.split(",").map((name) => name.trim()).filter(Boolean))];
    if (!names.length) throw new Error("Choose at least one game.");
    return Promise.all(names.map((name) => this.resolveOne(guildId, name)));
  }

  private async resolveOne(guildId: string, name: string): Promise<Game> {
    const found = await this.db
      .prepare("SELECT id, name, provider_id AS providerId FROM games WHERE guild_id = ? AND name = ?")
      .bind(guildId, name)
      .first<Game>();
    if (found) return found;
    const external = (await this.provider.search(name)).find((game) => game.name.toLowerCase() === name.toLowerCase());
    const game = {
      id: crypto.randomUUID(),
      name: external?.name ?? name,
      providerId: external?.providerId,
    };
    await this.db
      .prepare("INSERT OR IGNORE INTO games (id, guild_id, name, provider_id) VALUES (?, ?, ?, ?)")
      .bind(game.id, guildId, game.name, game.providerId ?? null)
      .run();
    return (await this.db.prepare("SELECT id, name, provider_id AS providerId FROM games WHERE guild_id = ? AND name = ?")
      .bind(guildId, game.name).first<Game>())!;
  }
}
