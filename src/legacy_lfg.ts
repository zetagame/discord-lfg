type LegacyLfgRow = {
  id: string;
  guildId: string;
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
 * written by the old Worker in the small gap is claimed, imported, and retired
 * in one D1 batch. The per-row token makes concurrent reconciliation harmless:
 * only the worker that won the claim can write shared membership state.
 */
export async function reconcileLegacyLfgs(db: D1Database): Promise<void> {
  const rows = await db.prepare(`
    SELECT id, guild_id AS guildId
    FROM lfgs
    WHERE stopped_at IS NULL AND julianday(expires_at) > julianday('now')
    ORDER BY created_at ASC
  `).all<LegacyLfgRow>();

  for (const row of rows.results) {
    const games = await db.prepare("SELECT game_id AS gameId FROM lfg_games WHERE lfg_id = ?")
      .bind(row.id).all<LegacyGameRow>();
    const token = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`
        UPDATE lfgs SET legacy_import_token = ?
        WHERE id = ? AND stopped_at IS NULL AND legacy_import_token IS NULL
          AND julianday(expires_at) > julianday('now')
      `).bind(token, row.id),
      ...games.results.flatMap(({ gameId }) => {
        const id = groupId(row.guildId, gameId);
        return [
          db.prepare(`
            INSERT INTO game_groups (id, guild_id, game_id, channel_id)
            SELECT ?, guild_id, ?, channel_id
            FROM lfgs WHERE id = ? AND legacy_import_token = ?
            ON CONFLICT(guild_id, game_id) DO UPDATE SET
              channel_id = CASE
                WHEN game_groups.discord_message_id IS NULL THEN excluded.channel_id
                ELSE game_groups.channel_id
              END
          `).bind(id, gameId, row.id, token),
          db.prepare(`
            INSERT INTO group_members (group_id, user_id, expires_at, paused_at, updated_at)
            SELECT ?, author_id, expires_at, paused_at, created_at
            FROM lfgs WHERE id = ? AND legacy_import_token = ?
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
          `).bind(id, row.id, token),
        ];
      }),
      db.prepare(`
        UPDATE lfgs
        SET stopped_at = COALESCE(stopped_at, ?),
            finalized_at = COALESCE(finalized_at, ?),
            legacy_import_token = NULL
        WHERE id = ? AND legacy_import_token = ?
      `).bind(now, now, row.id, token),
    ]);
  }
}
