ALTER TABLE game_groups ADD COLUMN panel_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_groups ADD COLUMN panel_applied_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_groups ADD COLUMN panel_create_nonce TEXT;
ALTER TABLE game_groups ADD COLUMN panel_last_error TEXT;
ALTER TABLE game_groups ADD COLUMN panel_last_attempt_at TEXT;

-- Membership writes and the public-panel dirty marker commit together. This is
-- the durable write-complete hook; Discord projection happens after commit.
CREATE TRIGGER IF NOT EXISTS group_members_panel_insert
AFTER INSERT ON group_members
BEGIN
  UPDATE game_groups
  SET panel_revision = panel_revision + 1,
      panel_last_error = NULL
  WHERE id = NEW.group_id;
END;

CREATE TRIGGER IF NOT EXISTS group_members_panel_update
AFTER UPDATE OF expires_at, paused_at ON group_members
BEGIN
  UPDATE game_groups
  SET panel_revision = panel_revision + 1,
      panel_last_error = NULL
  WHERE id = NEW.group_id;
END;

CREATE TRIGGER IF NOT EXISTS group_members_panel_delete
AFTER DELETE ON group_members
BEGIN
  UPDATE game_groups
  SET panel_revision = panel_revision + 1,
      panel_last_error = NULL
  WHERE id = OLD.group_id;
END;
