export interface LfgControlReference {
  applicationId: string;
  interactionToken: string;
  messageId: string;
}

export interface PendingControlSession {
  nonce: string;
}

export async function beginControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  applicationId: string,
  interactionToken: string,
): Promise<PendingControlSession> {
  const nonce = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO lfg_control_sessions (
      guild_id, game_id, user_id, nonce, application_id, interaction_token, message_id,
      previous_application_id, previous_interaction_token, previous_message_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(guild_id, game_id, user_id) DO UPDATE SET
      previous_application_id = CASE
        WHEN lfg_control_sessions.message_id IS NOT NULL THEN lfg_control_sessions.application_id
        ELSE lfg_control_sessions.previous_application_id
      END,
      previous_interaction_token = CASE
        WHEN lfg_control_sessions.message_id IS NOT NULL THEN lfg_control_sessions.interaction_token
        ELSE lfg_control_sessions.previous_interaction_token
      END,
      previous_message_id = COALESCE(lfg_control_sessions.message_id, lfg_control_sessions.previous_message_id),
      nonce = excluded.nonce,
      application_id = excluded.application_id,
      interaction_token = excluded.interaction_token,
      message_id = NULL,
      updated_at = excluded.updated_at
  `).bind(guildId, gameId, userId, nonce, applicationId, interactionToken, now).run();
  return { nonce };
}

export async function finalizeControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  nonce: string,
  messageId: string,
): Promise<{ current: boolean; previous?: LfgControlReference }> {
  const row = await db.prepare(`
    UPDATE lfg_control_sessions
    SET message_id = ?, updated_at = ?
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND nonce = ?
    RETURNING previous_application_id AS previousApplicationId,
      previous_interaction_token AS previousInteractionToken,
      previous_message_id AS previousMessageId
  `).bind(messageId, new Date().toISOString(), guildId, gameId, userId, nonce).first<{
    previousApplicationId?: string;
    previousInteractionToken?: string;
    previousMessageId?: string;
  }>();
  if (!row) return { current: false };
  const previous = row.previousApplicationId && row.previousInteractionToken && row.previousMessageId
    ? {
      applicationId: row.previousApplicationId,
      interactionToken: row.previousInteractionToken,
      messageId: row.previousMessageId,
    }
    : undefined;
  return { current: true, previous };
}

export async function abandonControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  nonce: string,
): Promise<void> {
  const restored = await db.prepare(`
    UPDATE lfg_control_sessions
    SET application_id = previous_application_id,
      interaction_token = previous_interaction_token,
      message_id = previous_message_id,
      previous_application_id = NULL,
      previous_interaction_token = NULL,
      previous_message_id = NULL,
      updated_at = ?
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND nonce = ?
      AND previous_application_id IS NOT NULL
      AND previous_interaction_token IS NOT NULL
      AND previous_message_id IS NOT NULL
  `).bind(new Date().toISOString(), guildId, gameId, userId, nonce).run();
  if (restored.meta.changes) return;
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND nonce = ?
  `).bind(guildId, gameId, userId, nonce).run();
}

export async function clearPreviousControl(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  nonce: string,
  messageId: string,
): Promise<void> {
  await db.prepare(`
    UPDATE lfg_control_sessions
    SET previous_application_id = NULL,
      previous_interaction_token = NULL,
      previous_message_id = NULL
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND nonce = ? AND message_id = ?
  `).bind(guildId, gameId, userId, nonce, messageId).run();
}

export async function refreshControlSessionToken(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  messageId: string | undefined,
  applicationId: string | undefined,
  interactionToken: string,
): Promise<void> {
  if (!messageId || !applicationId) return;
  await db.prepare(`
    UPDATE lfg_control_sessions
    SET application_id = ?, interaction_token = ?, updated_at = ?
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND message_id = ?
  `).bind(applicationId, interactionToken, new Date().toISOString(), guildId, gameId, userId, messageId).run();
}

export async function clearControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  messageId?: string,
): Promise<void> {
  if (messageId) {
    await db.prepare(`
      DELETE FROM lfg_control_sessions
      WHERE guild_id = ? AND game_id = ? AND user_id = ? AND message_id = ?
    `).bind(guildId, gameId, userId, messageId).run();
    return;
  }
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE guild_id = ? AND game_id = ? AND user_id = ?
  `).bind(guildId, gameId, userId).run();
}

export async function pruneControlSessions(db: D1Database): Promise<void> {
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE julianday(updated_at) <= julianday('now', '-14 minutes')
  `).run();
}
