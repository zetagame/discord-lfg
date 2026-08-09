CREATE TABLE IF NOT EXISTS game_groups (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  channel_id TEXT,
  discord_message_id TEXT,
  panel_claim_token TEXT,
  panel_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, game_id)
);

CREATE INDEX IF NOT EXISTS game_groups_game
ON game_groups (guild_id, game_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES game_groups(id),
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paused_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_active
ON group_members (group_id, expires_at, paused_at);
