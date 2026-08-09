export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN?: string;
  IGDB_CLIENT_ID?: string;
  IGDB_CLIENT_SECRET?: string;
}

export interface DiscordInteraction {
  id: string;
  application_id?: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string; username: string }; permissions?: string };
  user?: { id: string; username: string };
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: CommandOption[];
  };
}

export interface CommandOption {
  name: string;
  value?: string | number | boolean;
  focused?: boolean;
  options?: CommandOption[];
}

export interface Game {
  id: string;
  name: string;
  providerId?: string;
  coverUrl?: string;
  createdByUserId?: string;
}
