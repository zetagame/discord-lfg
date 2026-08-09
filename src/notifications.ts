export type NotificationAction = "listen" | "unlisten";

export async function recordNotificationAction(
  db: D1Database, guildId: string, userId: string, gameIds: string[], action: NotificationAction, expiresAt?: Date,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await db.batch(gameIds.map((gameId) => db.prepare(
    "INSERT INTO notification_actions (id, guild_id, user_id, game_id, action, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), guildId, userId, gameId, action, createdAt, expiresAt?.toISOString() ?? null)));
}

export async function matchingListeners(db: D1Database, guildId: string, gameIds: string[], excludedUserId: string): Promise<string[]> {
  if (!gameIds.length) return [];
  const placeholders = gameIds.map(() => "?").join(",");
  const result = await db.prepare(`
    WITH latest AS (
      SELECT user_id, game_id, action,
        ROW_NUMBER() OVER (PARTITION BY user_id, game_id ORDER BY created_at DESC, id DESC) AS position
      FROM notification_actions
      WHERE guild_id = ? AND game_id IN (${placeholders})
        AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
    )
    SELECT DISTINCT user_id FROM latest
    WHERE position = 1 AND action = 'listen' AND user_id != ?
  `).bind(guildId, ...gameIds, excludedUserId).all<{ user_id: string }>();
  return result.results.map(({ user_id }) => user_id);
}
