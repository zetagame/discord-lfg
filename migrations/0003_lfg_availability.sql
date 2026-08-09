ALTER TABLE lfgs ADD COLUMN paused_at TEXT;
ALTER TABLE lfgs ADD COLUMN stopped_at TEXT;
ALTER TABLE lfgs ADD COLUMN discord_message_id TEXT;
ALTER TABLE lfgs ADD COLUMN finalized_at TEXT;

CREATE INDEX IF NOT EXISTS lfgs_availability_lookup
ON lfgs (guild_id, expires_at, stopped_at, paused_at);

CREATE TABLE IF NOT EXISTS lfg_overlap_pairs (
  guild_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, game_id, user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS lfg_overlap_pairs_game
ON lfg_overlap_pairs (guild_id, game_id);

WITH active AS (
  SELECT DISTINCT lfgs.guild_id, lfg_games.game_id, lfgs.author_id
  FROM lfgs
  JOIN lfg_games ON lfg_games.lfg_id = lfgs.id
  WHERE lfgs.stopped_at IS NULL AND lfgs.paused_at IS NULL
    AND julianday(lfgs.expires_at) > julianday('now')
)
INSERT OR IGNORE INTO lfg_overlap_pairs (guild_id, game_id, user_a, user_b, created_at)
SELECT left_side.guild_id, left_side.game_id, left_side.author_id, right_side.author_id, CURRENT_TIMESTAMP
FROM active AS left_side
JOIN active AS right_side
  ON right_side.guild_id = left_side.guild_id
  AND right_side.game_id = left_side.game_id
  AND left_side.author_id < right_side.author_id;

DELETE FROM notification_actions;
