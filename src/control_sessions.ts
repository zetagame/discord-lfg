export interface LfgControlSession {
  guildId: string;
  gameId: string;
  userId: string;
  nonce: string;
  applicationId: string;
  interactionToken: string;
  messageId?: string;
  updatedAt: string;
}

export interface PendingControlSession {
  nonce: string;
  previous?: LfgControlSession;
}

export async function beginControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  applicationId: string,
  interactionToken: string,
): Promise<PendingControlSession> {
  const previous = await loadControlSession(db, guildId, gameId, userId);
  const nonce = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO lfg_control_sessions (
      guild_id, game_id, user_id, nonce, application_id, interaction_token, message_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(guild_id, game_id, user_id) DO UPDATE SET
      nonce = excluded.nonce,
      application_id = excluded.application_id,
      interaction_token = excluded.interaction_token,
      message_id = NULL,
      updated_at = excluded.updated_at
  `).bind(guildId, gameId, userId, nonce, applicationId, interactionToken, now).run();
  return { nonce, previous };
}

export async function finalizeControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  nonce: string,
  messageId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE lfg_control_sessions
    SET message_id = ?, updated_at = ?
    WHERE guild_id = ? AND game_id = ? AND user_id = ? AND nonce = ?
  `).bind(messageId, new Date().toISOString(), guildId, gameId, userId, nonce).run();
  return Boolean(result.meta.changes);
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
    WHERE julianday(updated_at) <= julianday('now', '-20 minutes')
  `).run();
}

async function loadControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
): Promise<LfgControlSession | undefined> {
  const row = await db.prepare(`
    SELECT guild_id AS guildId, game_id AS gameId, user_id AS userId, nonce,
      application_id AS applicationId, interaction_token AS interactionToken,
      message_id AS messageId, updated_at AS updatedAt
    FROM lfg_control_sessions
    WHERE guild_id = ? AND game_id = ? AND user_id = ?
  `).bind(guildId, gameId, userId).first<LfgControlSession>();
  return row ?? undefined;
}
