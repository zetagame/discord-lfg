export type NotificationAction = "listen" | "unlisten";
export interface NotificationInstruction { action: NotificationAction; createdAt: Date; expiresAt?: Date; }

export function effectiveNotificationAction(instructions: NotificationInstruction[], now = new Date()): NotificationAction | undefined {
  return instructions
    .filter((instruction) => !instruction.expiresAt || instruction.expiresAt > now)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]?.action;
}

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
    SELECT id, user_id, game_id, action, created_at
    FROM notification_actions
    WHERE guild_id = ? AND game_id IN (${placeholders}) AND user_id != ?
      AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
    ORDER BY created_at DESC, id DESC
  `).bind(guildId, ...gameIds, excludedUserId).all<{
    id: string;
    user_id: string;
    game_id: string;
    action: NotificationAction;
    created_at: string;
  }>();
  const latest = new Map<string, NotificationAction>();
  for (const row of result.results) {
    const key = `${row.user_id}:${row.game_id}`;
    if (!latest.has(key)) latest.set(key, row.action);
  }
  const users = new Set<string>();
  for (const [key, action] of latest.entries()) {
    if (action !== "listen") continue;
    users.add(key.slice(0, key.indexOf(":")));
  }
  return [...users];
}
