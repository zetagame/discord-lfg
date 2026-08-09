-- Private LFG controls are now one aggregate manager per user, not one panel per game.
-- Existing ephemeral controls cannot be migrated meaningfully because their Discord
-- interaction tokens/messages are already short-lived; invalidate them on deploy.
DROP INDEX IF EXISTS lfg_control_sessions_updated;
DROP TABLE IF EXISTS lfg_control_sessions;

CREATE TABLE lfg_control_sessions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  current_application_id TEXT,
  current_interaction_token TEXT,
  current_message_id TEXT,
  opening_nonce TEXT,
  opening_application_id TEXT,
  opening_interaction_token TEXT,
  opening_started_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX lfg_control_sessions_updated
ON lfg_control_sessions (updated_at);
