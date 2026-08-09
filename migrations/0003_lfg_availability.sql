ALTER TABLE lfgs ADD COLUMN paused_at TEXT;
ALTER TABLE lfgs ADD COLUMN stopped_at TEXT;
ALTER TABLE lfgs ADD COLUMN discord_message_id TEXT;
ALTER TABLE lfgs ADD COLUMN finalized_at TEXT;

CREATE INDEX IF NOT EXISTS lfgs_availability_lookup
ON lfgs (guild_id, expires_at, stopped_at, paused_at);

DELETE FROM notification_actions;
