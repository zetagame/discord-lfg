ALTER TABLE games ADD COLUMN created_by_user_id TEXT;
ALTER TABLE games ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS games_guild_active_name
ON games (guild_id, deleted_at, name);
