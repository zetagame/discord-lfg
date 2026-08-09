export interface LfgControlSession {
  guildId: string;
  gameId: string;
  userId: string;
  sessionId: string;
  applicationId: string;
  interactionToken: string;
  messageRef: string;
  expiresAt: string;
}

const CONTROL_SESSION_TTL_MS = 14 * 60_000;

export async function loadLfgControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
): Promise<LfgControlSession | undefined> {
  const row = await db.prepare(`
    SELECT guild_id AS guildId, game_id AS gameId, user_id AS userId,
      session_id AS sessionId, application_id AS applicationId,
      interaction_token AS interactionToken, message_ref AS messageRef,
      expires_at AS expiresAt
    FROM lfg_control_sessions
    WHERE guild_id = ? AND game_id = ? AND user_id = ?
  `).bind(guildId, gameId, userId).first<LfgControlSession>();
  return row ?? undefined;
}

export async function saveLfgControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  sessionId: string,
  applicationId: string,
  interactionToken: string,
  messageRef = "@original",
): Promise<LfgControlSession> {
  const expiresAt = new Date(Date.now() + CONTROL_SESSION_TTL_MS).toISOString();
  await db.prepare(`
    INSERT INTO lfg_control_sessions (
      guild_id, game_id, user_id, session_id, application_id,
      interaction_token, message_ref, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, game_id, user_id) DO UPDATE SET
      session_id = excluded.session_id,
      application_id = excluded.application_id,
      interaction_token = excluded.interaction_token,
      message_ref = excluded.message_ref,
      expires_at = excluded.expires_at
  `).bind(
    guildId,
    gameId,
    userId,
    sessionId,
    applicationId,
    interactionToken,
    messageRef,
    expiresAt,
  ).run();
  return { guildId, gameId, userId, sessionId, applicationId, interactionToken, messageRef, expiresAt };
}

export async function clearLfgControlSession(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  if (sessionId) {
    await db.prepare(`
      DELETE FROM lfg_control_sessions
      WHERE guild_id = ? AND game_id = ? AND user_id = ? AND session_id = ?
    `).bind(guildId, gameId, userId, sessionId).run();
    return;
  }
  await db.prepare(`
    DELETE FROM lfg_control_sessions
    WHERE guild_id = ? AND game_id = ? AND user_id = ?
  `).bind(guildId, gameId, userId).run();
}

export async function pruneLfgControlSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM lfg_control_sessions WHERE julianday(expires_at) <= julianday('now')").run();
}
