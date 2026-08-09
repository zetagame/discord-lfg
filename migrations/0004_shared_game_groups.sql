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

-- Seed one shared group per guild/game from any still-open legacy LFGs. New
-- panels are posted by the new Worker so one legacy multi-game message can never
-- accidentally become the canonical panel for several games.
INSERT OR IGNORE INTO game_groups (id, guild_id, game_id, channel_id, created_at)
SELECT
  l.guild_id || ':' || lg.game_id,
  l.guild_id,
  lg.game_id,
  (
    SELECT l2.channel_id
    FROM lfgs l2
    JOIN lfg_games lg2 ON lg2.lfg_id = l2.id
    WHERE l2.guild_id = l.guild_id AND lg2.game_id = lg.game_id
      AND l2.stopped_at IS NULL AND julianday(l2.expires_at) > julianday('now')
    ORDER BY l2.created_at DESC LIMIT 1
  ),
  CURRENT_TIMESTAMP
FROM lfgs l
JOIN lfg_games lg ON lg.lfg_id = l.id
WHERE l.stopped_at IS NULL AND julianday(l.expires_at) > julianday('now')
GROUP BY l.guild_id, lg.game_id;

-- Collapse duplicate legacy LFGs into one membership per user/game. The longest
-- remaining expiry wins. If any live legacy LFG is unpaused, the member is active.
INSERT OR REPLACE INTO group_members (group_id, user_id, expires_at, paused_at, updated_at)
SELECT
  l.guild_id || ':' || lg.game_id,
  l.author_id,
  MAX(l.expires_at),
  CASE
    WHEN SUM(CASE WHEN l.paused_at IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
    ELSE MAX(l.paused_at)
  END,
  MAX(l.created_at)
FROM lfgs l
JOIN lfg_games lg ON lg.lfg_id = l.id
WHERE l.stopped_at IS NULL AND julianday(l.expires_at) > julianday('now')
GROUP BY l.guild_id, lg.game_id, l.author_id;
