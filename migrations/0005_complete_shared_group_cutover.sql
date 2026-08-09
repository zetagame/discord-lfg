-- Finish the legacy -> shared-group handoff without resurrecting memberships that
-- users have already Pause/Stopped in the shared model.
--
-- If 0004 and 0005 are applied together, game_groups is still empty. Capture
-- those missing groups, seed their live legacy memberships, then retire the
-- source rows. On an already-running shared deployment, an existing game_group
-- is the ownership marker: do not recreate a missing member from old legacy
-- state, because that absence may be an intentional Stop.
ALTER TABLE lfgs ADD COLUMN legacy_import_token TEXT;

CREATE TABLE lfg_cutover_new_groups (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO lfg_cutover_new_groups (id)
SELECT DISTINCT l.guild_id || ':' || lg.game_id
FROM lfgs l
JOIN lfg_games lg ON lg.lfg_id = l.id
LEFT JOIN game_groups gg
  ON gg.guild_id = l.guild_id AND gg.game_id = lg.game_id
WHERE l.stopped_at IS NULL
  AND julianday(l.expires_at) > julianday('now')
  AND gg.id IS NULL;

INSERT OR IGNORE INTO game_groups (id, guild_id, game_id, channel_id)
SELECT seeds.id, l.guild_id, lg.game_id, MAX(l.channel_id)
FROM lfgs l
JOIN lfg_games lg ON lg.lfg_id = l.id
JOIN lfg_cutover_new_groups seeds
  ON seeds.id = l.guild_id || ':' || lg.game_id
WHERE l.stopped_at IS NULL
  AND julianday(l.expires_at) > julianday('now')
GROUP BY seeds.id, l.guild_id, lg.game_id;

INSERT OR IGNORE INTO group_members (
  group_id,
  user_id,
  expires_at,
  paused_at,
  updated_at
)
SELECT
  seeds.id,
  l.author_id,
  MAX(l.expires_at),
  CASE
    WHEN SUM(CASE WHEN l.paused_at IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
    ELSE MAX(l.paused_at)
  END,
  MAX(l.created_at)
FROM lfgs l
JOIN lfg_games lg ON lg.lfg_id = l.id
JOIN lfg_cutover_new_groups seeds
  ON seeds.id = l.guild_id || ':' || lg.game_id
WHERE l.stopped_at IS NULL
  AND julianday(l.expires_at) > julianday('now')
GROUP BY seeds.id, l.author_id;

-- Everything visible before this point is now either already owned by the shared
-- model or was seeded above. Retire it so future reconciliation cannot undo a
-- shared Pause/Stop. The old Worker can still create rows after this migration;
-- the new Worker claims, imports, and retires those deployment-gap rows once.
UPDATE lfgs
SET stopped_at = COALESCE(stopped_at, CURRENT_TIMESTAMP),
    finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP)
WHERE stopped_at IS NULL
  AND julianday(expires_at) > julianday('now');

DROP TABLE lfg_cutover_new_groups;
