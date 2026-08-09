-- The shared-group Worker is now the only writer of live LFG state. Remove any
-- untouched memberships copied from the legacy per-post model so stale pre-cutover
-- LFGs do not surface as new shared panels. Memberships changed through the new
-- model have a newer updated_at and are preserved.
DELETE FROM group_members
WHERE EXISTS (
  SELECT 1
  FROM game_groups
  JOIN lfg_games ON lfg_games.game_id = game_groups.game_id
  JOIN lfgs ON lfgs.id = lfg_games.lfg_id
  WHERE game_groups.id = group_members.group_id
    AND lfgs.guild_id = game_groups.guild_id
    AND lfgs.author_id = group_members.user_id
  GROUP BY game_groups.id, lfgs.author_id
  HAVING julianday(group_members.updated_at) <= MAX(julianday(lfgs.created_at))
);

-- Finish the one-way handoff. The new Worker never writes these legacy rows, so
-- they must no longer be eligible for reconciliation or resurrection.
UPDATE lfgs
SET stopped_at = COALESCE(stopped_at, CURRENT_TIMESTAMP),
    finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP)
WHERE stopped_at IS NULL OR finalized_at IS NULL;

-- A removed custom game is not a valid live LFG surface. Scheduled event records
-- can keep their historical game reference, but active shared membership ends.
DELETE FROM group_members
WHERE group_id IN (
  SELECT game_groups.id
  FROM game_groups
  JOIN games ON games.id = game_groups.game_id
  WHERE games.deleted_at IS NOT NULL
);
