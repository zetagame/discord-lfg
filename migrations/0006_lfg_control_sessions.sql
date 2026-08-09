CREATE TABLE IF NOT EXISTS lfg_control_sessions (
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  interaction_token TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, game_id, user_id)
);

CREATE INDEX IF NOT EXISTS lfg_control_sessions_expiry
ON lfg_control_sessions (expires_at);
