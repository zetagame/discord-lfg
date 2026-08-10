export interface LfgControlReference {
  applicationId: string;
  interactionToken: string;
  messageId: string;
}

export interface PendingControlSession {
  nonce: string;
  previous?: LfgControlReference;
}

const OPENING_LEASE_MS = 15_000;

export async function beginControlSession(
  db: D1Database,
  guildId: string,
  userId: string,
  applicationId: string,
  interactionToken: string,
): Promise<PendingControlSession | undefined> {
  const nonce = crypto.randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - OPENING_LEASE_MS).toISOString();
  const row = await db.prepare(`
    INSERT INTO lfg_control_sessions (
      guild_id, user_id,
      current_application_id, current_interaction_token, current_message_id,
      opening_nonce, opening_application_id, opening_interaction_token, opening_started_at, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      opening_nonce = excluded.opening_nonce,
      opening_application_id = excluded.opening_application_id,
      opening_interaction_token = excluded.opening_interaction_token,
      opening_started_at = excluded.opening_started_at,
      updated_at = excluded.updated_at
    WHERE lfg_control_sessions.opening_nonce IS NULL
      OR lfg_control_sessions.opening_started_at IS NULL
      OR lfg_control_sessions.opening_started_at <= ?
    RETURNING current_application_id AS currentApplicationId,
      current_interaction_token AS currentInteractionToken,
      current_message_id AS currentMessageId
  `).bind(
    guildId,
    userId,
    nonce,
    applicationId,
    interactionToken,
    now.toISOString(),
    now.toISOString(),
    staleBefore,
  ).first<{
    currentApplicationId?: string;
    currentInteractionToken?: string;
    currentMessageId?: string;
  }>();
  if (!row) return undefined;
  const previous = row.currentApplicationId && row.currentInteractionToken && row.currentMessageId
    ? {
      applicationId: row.currentApplicationId,
      interactionToken: row.currentInteractionToken,
      messageId: row.currentMessageId,
    }
    : undefined;
  return { nonce, previous };
}

export async function promoteControlSession(
  db: D1Database,
  guildId: string,
  userId: string,
  nonce: string,
  messageId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE lfg_control_sessions
    SET current_application_id = opening_application_id,
      current_interaction_token = opening_interaction_token,
      current_message_id = ?,
      opening_nonce = NULL,
      opening_application_id = NULL,
      opening_interaction_token = NULL,
      opening_started_at = NULL,
      updated_at = ?
    WHERE guild_id = ? AND user_id = ? AND opening_nonce = ?
  `).bind(messageId, new Date().toISOString(), guildId, userId, nonce).run();
  return Boolean(result.meta.changes);
}

export async function currentControlMessageForInteraction(
  db: D1Database,
  guildId: string,
  userId: string,
  interactionToken: string,
): Promise<string | undefined> {
  const row = await db.prepare(`
    SELECT current_message_id AS messageId
    FROM lfg_control_sessions
    WHERE guild_id = ? AND user_id = ? AND current_interaction_token = ?
  `).bind(guildId, userId, interactionToken).first<{ messageId?: string }>();
  return row?.messageId;
}

export async function rebindControlSessionMessage(
  db: D1Database,
  guildId: string,
  userId: string,
  interactionToken: string,
  previousMessageId: string,
  messageId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE lfg_control_sessions
    SET current_message_id = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
      AND current_interaction_token = ? AND current_message_id = ?
  `).bind(
    messageId,
    new Date().toISOString(),
    guildId,
    userId,
    interactionToken,
    previousMessageId,
  ).run();
  return Boolean(result.meta.changes);
}

export async function cancelControlSessionOpening(
  db: D1Database,
  guildId: string,
  userId: string,
  nonce: string,
): Promise<void> {
  await db.prepare(`
    UPDATE lfg_control_sessions
    SET opening_nonce = NULL,
      opening_application_id = NULL,
      opening_interaction_token = NULL,
      opening_started_at = NULL,
      updated_at = ?
    WHERE guild_id = ? AND user_id = ? AND opening_nonce = ?
  `).bind(new Date().toISOString(), guildId, userId, nonce).run();
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE guild_id = ? AND user_id = ?
      AND current_message_id IS NULL AND opening_nonce IS NULL
  `).bind(guildId, userId).run();
}

export async function refreshControlSessionToken(
  db: D1Database,
  guildId: string,
  userId: string,
  messageId: string | undefined,
  applicationId: string | undefined,
  interactionToken: string,
): Promise<void> {
  if (!messageId || !applicationId) return;
  await db.prepare(`
    UPDATE lfg_control_sessions
    SET current_application_id = ?, current_interaction_token = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ? AND current_message_id = ?
  `).bind(applicationId, interactionToken, new Date().toISOString(), guildId, userId, messageId).run();
}

export async function takeControlSession(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<LfgControlReference | undefined> {
  const row = await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE guild_id = ? AND user_id = ?
    RETURNING current_application_id AS applicationId,
      current_interaction_token AS interactionToken,
      current_message_id AS messageId
  `).bind(guildId, userId).first<LfgControlReference>();
  return row?.applicationId && row.interactionToken && row.messageId ? row : undefined;
}

export async function pruneControlSessions(db: D1Database): Promise<void> {
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE julianday(updated_at) <= julianday('now', '-14 minutes')
  `).run();
}
