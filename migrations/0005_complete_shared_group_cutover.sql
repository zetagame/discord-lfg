-- Migration 0004 already copied every live legacy LFG visible at migration time
-- into the shared group model. Retire exactly those source rows now so the new
-- Worker can never reconcile them again and overwrite a later Pause/Stop.
--
-- The old Worker can still finish a request during the deploy cutover. Any LFG
-- written after this migration is intentionally left unstopped; the new Worker
-- imports and retires those gap rows once at runtime.
ALTER TABLE lfgs ADD COLUMN legacy_import_token TEXT;

UPDATE lfgs
SET stopped_at = COALESCE(stopped_at, CURRENT_TIMESTAMP),
    finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP)
WHERE stopped_at IS NULL
  AND julianday(expires_at) > julianday('now');
