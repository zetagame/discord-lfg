type LegacyLfgRow = {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  expiresAt: string;
  pausedAt?: string;
  createdAt: string;
};

type LegacyGameRow = { gameId: string };

function groupId(guildId: string, gameId: string): string {
  return `${guildId}:${gameId}`;
}

/**
 * Imports LFGs created by the previous Worker during the deployment cutover.
 *
 * Migration 0004 seeded the rows that existed when migrations ran. Migration
 * 0005 retires those source rows before the new Worker is swapped in. Anything
 * written by the old Worker in the small gap is imported here exactly once and
 * immediately retired, so later Pause/Stop actions in the shared model cannot
 * be undone by another legacy reconciliation pass.
 */
export async function reconcileLegacyLfgs(db: D1Database): Promise<void> {
  const rows = await db.prepare(`
    SELECT id, guild_id AS guildId, channel_id AS channelId, author_id AS userId,
      expires_at AS expiresAt, paused_at AS pausedAt, created_at AS createdAt
    FROM lfgs
    WHERE stopped_at IS NULL AND julianday(expires_at) > julianday('now')
    ORDER BY created_at ASC
  `).all<LegacyLfgRow>();

  for (const row of rows.results) {
    const games = await db.prepare("SELECT game_id AS gameId FROM lfg_games WHERE lfg_id = ?")
      .bind(row.id).all<LegacyGameRow>();
    const now = new Date().toISOString();

    await db.batch([
      ...games.results.flatMap(({ gameId }) => {
        const id = groupId(row.guildId, gameId);
        return [
          db.prepare(`
            INSERT INTO game_groups (id, guild_id, game_id, channel_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, game_id) DO UPDATE SET
              channel_id = CASE
                WHEN game_groups.discord_message_id IS NULL THEN excluded.channel_id
                ELSE game_groups.channel_id
              END
          `).bind(id, row.guildId, gameId, row.channelId),
          db.prepare(`
            INSERT INTO group_members (group_id, user_id, expires_at, paused_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(group_id, user_id) DO UPDATE SET
              expires_at = CASE
                WHEN julianday(excluded.expires_at) > julianday(group_members.expires_at) THEN excluded.expires_at
                ELSE group_members.expires_at
              END,
              paused_at = CASE
                WHEN group_members.paused_at IS NULL OR excluded.paused_at IS NULL THEN NULL
                ELSE excluded.paused_at
              END,
              updated_at = CASE
                WHEN excluded.updated_at > group_members.updated_at THEN excluded.updated_at
                ELSE group_members.updated_at
              END
          `).bind(id, row.userId, row.expiresAt, row.pausedAt ?? null, row.createdAt),
        ];
      }),
      db.prepare(`
        UPDATE lfgs
        SET stopped_at = COALESCE(stopped_at, ?), finalized_at = COALESCE(finalized_at, ?)
        WHERE id = ?
      `).bind(now, now, row.id),
    ]);
  }
}
