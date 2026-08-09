type LegacyMembership = {
  guildId: string;
  gameId: string;
  userId: string;
  channelId: string;
  expiresAt: string;
  pausedAt?: string;
  updatedAt: string;
};

function groupId(guildId: string, gameId: string): string {
  return `${guildId}:${gameId}`;
}

/**
 * Copies any still-live legacy LFG rows into the shared group model.
 *
 * This deliberately runs in the new Worker instead of in the D1 migration.
 * Cloudflare applies migrations before swapping Worker code, so copying mutable
 * LFG data inside the migration can miss writes made by the previous Worker in
 * that deployment window. The runtime reconciliation is idempotent and runs
 * before legacy cards are retired.
 */
export async function reconcileLegacyLfgs(db: D1Database): Promise<void> {
  const rows = await db.prepare(`
    SELECT
      l.guild_id AS guildId,
      lg.game_id AS gameId,
      l.author_id AS userId,
      MAX(l.channel_id) AS channelId,
      MAX(l.expires_at) AS expiresAt,
      CASE
        WHEN SUM(CASE WHEN l.paused_at IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
        ELSE MAX(l.paused_at)
      END AS pausedAt,
      MAX(l.created_at) AS updatedAt
    FROM lfgs l
    JOIN lfg_games lg ON lg.lfg_id = l.id
    WHERE l.stopped_at IS NULL AND julianday(l.expires_at) > julianday('now')
    GROUP BY l.guild_id, lg.game_id, l.author_id
  `).all<LegacyMembership>();

  for (const row of rows.results) {
    const id = groupId(row.guildId, row.gameId);
    await db.batch([
      db.prepare(`
        INSERT INTO game_groups (id, guild_id, game_id, channel_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, game_id) DO UPDATE SET
          channel_id = CASE
            WHEN game_groups.discord_message_id IS NULL THEN excluded.channel_id
            ELSE game_groups.channel_id
          END
      `).bind(id, row.guildId, row.gameId, row.channelId),
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
            ELSE group_members.paused_at
          END,
          updated_at = CASE
            WHEN excluded.updated_at > group_members.updated_at THEN excluded.updated_at
            ELSE group_members.updated_at
          END
      `).bind(id, row.userId, row.expiresAt, row.pausedAt ?? null, row.updatedAt),
    ]);
  }
}
