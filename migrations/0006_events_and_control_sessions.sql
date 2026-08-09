ALTER TABLE events ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS events_active_start
ON events (starts_at, deleted_at) WHERE starts_at IS NOT NULL;

-- One row owns the control-panel lifecycle for a user + game. Keep the current
-- usable panel while a replacement is opening; only promote the replacement
-- after the old panel has been closed successfully.
CREATE TABLE IF NOT EXISTS lfg_control_sessions (
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  current_application_id TEXT,
  current_interaction_token TEXT,
  current_message_id TEXT,
  opening_nonce TEXT,
  opening_application_id TEXT,
  opening_interaction_token TEXT,
  opening_started_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, game_id, user_id)
);

CREATE INDEX IF NOT EXISTS lfg_control_sessions_updated
ON lfg_control_sessions (updated_at);
