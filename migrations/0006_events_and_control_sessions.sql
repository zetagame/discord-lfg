ALTER TABLE events ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS events_active_start
ON events (starts_at, deleted_at) WHERE starts_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lfg_control_sessions (
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  application_id TEXT NOT NULL,
  interaction_token TEXT NOT NULL,
  message_id TEXT,
  previous_application_id TEXT,
  previous_interaction_token TEXT,
  previous_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, game_id, user_id)
);

CREATE INDEX IF NOT EXISTS lfg_control_sessions_updated
ON lfg_control_sessions (updated_at);
