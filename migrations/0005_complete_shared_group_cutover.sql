-- This bot is still in private testing, so finish the legacy -> shared-group
-- cutover by resetting transient availability once instead of carrying forward
-- ambiguous per-post state. Events and games are preserved; testers simply run
-- /lfg again after this deployment.
--
-- This removes the possibility that an old legacy LFG can recreate a membership
-- the user already paused or stopped in the shared model.
UPDATE lfgs
SET stopped_at = COALESCE(stopped_at, CURRENT_TIMESTAMP),
    finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP)
WHERE stopped_at IS NULL OR finalized_at IS NULL;

DELETE FROM group_members;
DELETE FROM lfg_overlap_pairs;
