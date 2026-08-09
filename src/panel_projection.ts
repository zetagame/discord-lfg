export interface PanelProjectionState {
  revision: number;
  appliedRevision: number;
  createNonce?: string;
  lastError?: string;
  lastAttemptAt?: string;
}

export async function loadPanelProjectionState(db: D1Database, groupId: string): Promise<PanelProjectionState | undefined> {
  const row = await db.prepare(`
    SELECT panel_revision AS revision,
      panel_applied_revision AS appliedRevision,
      panel_create_nonce AS createNonce,
      panel_last_error AS lastError,
      panel_last_attempt_at AS lastAttemptAt
    FROM game_groups WHERE id = ?
  `).bind(groupId).first<PanelProjectionState>();
  return row ?? undefined;
}

export async function ensurePanelCreateNonce(db: D1Database, groupId: string): Promise<string> {
  const candidate = crypto.randomUUID().replaceAll("-", "").slice(0, 25);
  await db.prepare(`
    UPDATE game_groups
    SET panel_create_nonce = COALESCE(panel_create_nonce, ?)
    WHERE id = ?
  `).bind(candidate, groupId).run();
  const row = await db.prepare("SELECT panel_create_nonce AS nonce FROM game_groups WHERE id = ?")
    .bind(groupId).first<{ nonce?: string }>();
  if (!row?.nonce) throw new Error("Could not allocate a panel create nonce.");
  return row.nonce;
}

export async function clearPanelCreateNonce(db: D1Database, groupId: string): Promise<void> {
  await db.prepare("UPDATE game_groups SET panel_create_nonce = NULL WHERE id = ?").bind(groupId).run();
}

export async function markPanelProjectionApplied(db: D1Database, groupId: string, revision: number): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE game_groups
    SET panel_applied_revision = CASE
        WHEN panel_applied_revision < ? THEN ?
        ELSE panel_applied_revision
      END,
      panel_last_attempt_at = ?,
      panel_last_error = CASE WHEN panel_revision <= ? THEN NULL ELSE panel_last_error END
    WHERE id = ?
  `).bind(revision, revision, now, revision, groupId).run();
}

export async function recordPanelProjectionError(db: D1Database, groupId: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  await db.prepare(`
    UPDATE game_groups SET panel_last_attempt_at = ?, panel_last_error = ? WHERE id = ?
  `).bind(new Date().toISOString(), detail.slice(0, 1000), groupId).run();
}
