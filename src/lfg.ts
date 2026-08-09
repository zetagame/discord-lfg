import type { Game } from "./types";

const ANY_GAME_PROVIDER_ID = "system:any";

export type GroupMemberState = "active" | "paused" | "expired" | "missing";

export interface GameGroup {
  id: string;
  guildId: string;
  gameId: string;
  channelId?: string;
  discordMessageId?: string;
  panelClaimToken?: string;
  panelClaimedAt?: string;
}

export interface GroupMember {
  userId: string;
  expiresAt: string;
  pausedAt?: string;
}

export interface UpcomingGroupEvent {
  id: string;
  title: string;
  startsAt: string;
  channelId: string;
  yesCount: number;
}

export interface GameGroupSnapshot {
  group: GameGroup;
  game: Game;
  activeUserIds: string[];
  upcomingEvent?: UpcomingGroupEvent;
}

export interface MembershipUpdate {
  snapshot: GameGroupSnapshot;
  member?: GroupMember;
  newlyOverlapping: boolean;
  recipients: string[];
}

type ClaimedOverlap = { recipientUserId: string };

function gameGroupId(guildId: string, gameId: string): string {
  return `${guildId}:${gameId}`;
}

export function groupMemberState(member?: GroupMember, now = Date.now()): GroupMemberState {
  if (!member) return "missing";
  if (new Date(member.expiresAt).getTime() <= now) return "expired";
  return member.pausedAt ? "paused" : "active";
}

export async function ensureGameGroup(
  db: D1Database,
  guildId: string,
  gameId: string,
  channelId?: string,
): Promise<GameGroup> {
  const id = gameGroupId(guildId, gameId);
  await db.prepare(`
    INSERT INTO game_groups (id, guild_id, game_id, channel_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, game_id) DO UPDATE SET
      channel_id = CASE
        WHEN game_groups.discord_message_id IS NULL AND excluded.channel_id IS NOT NULL THEN excluded.channel_id
        ELSE game_groups.channel_id
      END
  `).bind(id, guildId, gameId, channelId ?? null).run();
  return (await loadGameGroup(db, guildId, gameId))!;
}

export async function loadGameGroup(db: D1Database, guildId: string, gameId: string): Promise<GameGroup | undefined> {
  const row = await db.prepare(`
    SELECT id, guild_id AS guildId, game_id AS gameId, channel_id AS channelId,
      discord_message_id AS discordMessageId, panel_claim_token AS panelClaimToken,
      panel_claimed_at AS panelClaimedAt
    FROM game_groups WHERE guild_id = ? AND game_id = ?
  `).bind(guildId, gameId).first<GameGroup>();
  return row ?? undefined;
}

export async function loadGroupMember(db: D1Database, groupId: string, userId: string): Promise<GroupMember | undefined> {
  const row = await db.prepare(`
    SELECT user_id AS userId, expires_at AS expiresAt, paused_at AS pausedAt
    FROM group_members WHERE group_id = ? AND user_id = ?
  `).bind(groupId, userId).first<GroupMember>();
  return row ?? undefined;
}

async function loadGame(db: D1Database, gameId: string): Promise<Game | undefined> {
  const row = await db.prepare(`
    SELECT id, name, provider_id AS providerId, cover_url AS coverUrl,
      created_by_user_id AS createdByUserId, deleted_at AS deletedAt
    FROM games WHERE id = ?
  `).bind(gameId).first<Game>();
  return row ?? undefined;
}

async function upcomingEventForGame(db: D1Database, guildId: string, gameId: string): Promise<UpcomingGroupEvent | undefined> {
  const row = await db.prepare(`
    SELECT events.id, events.title, events.starts_at AS startsAt, events.channel_id AS channelId,
      SUM(CASE WHEN rsvps.status = 'yes' THEN 1 ELSE 0 END) AS yesCount
    FROM event_games
    JOIN events ON events.id = event_games.event_id
    LEFT JOIN rsvps ON rsvps.event_id = events.id
    WHERE events.guild_id = ? AND event_games.game_id = ?
      AND events.deleted_at IS NULL
      AND events.starts_at IS NOT NULL
      AND julianday(events.starts_at) > julianday('now')
      AND julianday(events.starts_at) <= julianday('now', '+1 hour')
    GROUP BY events.id, events.title, events.starts_at, events.channel_id
    ORDER BY events.starts_at ASC
    LIMIT 1
  `).bind(guildId, gameId).first<UpcomingGroupEvent>();
  return row ?? undefined;
}

export async function activeUsersByGame(
  db: D1Database,
  guildId: string,
  gameIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!gameIds.length) return result;
  const placeholders = gameIds.map(() => "?").join(",");
  const rows = await db.prepare(`
    SELECT target.game_id AS gameId, group_members.user_id AS userId
    FROM game_groups AS target
    JOIN game_groups AS source ON source.guild_id = target.guild_id
      AND (
        source.game_id = target.game_id
        OR EXISTS (
          SELECT 1 FROM games AS source_game
          WHERE source_game.id = source.game_id AND source_game.provider_id = ?
        )
      )
    JOIN group_members ON group_members.group_id = source.id
    WHERE target.guild_id = ? AND target.game_id IN (${placeholders})
      AND group_members.paused_at IS NULL
      AND julianday(group_members.expires_at) > julianday('now')
    GROUP BY target.game_id, group_members.user_id
  `).bind(ANY_GAME_PROVIDER_ID, guildId, ...gameIds).all<{ gameId: string; userId: string }>();
  for (const row of rows.results) {
    const users = result.get(row.gameId) ?? [];
    users.push(row.userId);
    result.set(row.gameId, users);
  }
  return result;
}

export async function loadGameGroupSnapshot(
  db: D1Database,
  guildId: string,
  gameId: string,
): Promise<GameGroupSnapshot | undefined> {
  const group = await loadGameGroup(db, guildId, gameId);
  if (!group) return undefined;
  const game = await loadGame(db, gameId);
  if (!game) return undefined;
  const active = await activeUsersByGame(db, guildId, [gameId]);
  return {
    group,
    game,
    activeUserIds: active.get(gameId) ?? [],
    upcomingEvent: await upcomingEventForGame(db, guildId, gameId),
  };
}

async function pruneInactiveOverlapPairs(db: D1Database, guildId: string, gameIds: string[]): Promise<void> {
  if (!gameIds.length) return;
  const placeholders = gameIds.map(() => "?").join(",");
  await db.prepare(`
    DELETE FROM lfg_overlap_pairs
    WHERE guild_id = ?
      AND (
        game_id IN (${placeholders})
        OR EXISTS (SELECT 1 FROM games WHERE id IN (${placeholders}) AND provider_id = ?)
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM game_groups
          JOIN games ON games.id = game_groups.game_id
          JOIN group_members ON group_members.group_id = game_groups.id
          WHERE game_groups.guild_id = lfg_overlap_pairs.guild_id
            AND (game_groups.game_id = lfg_overlap_pairs.game_id OR games.provider_id = ?)
            AND group_members.user_id = lfg_overlap_pairs.user_a
            AND group_members.paused_at IS NULL
            AND julianday(group_members.expires_at) > julianday('now')
        ) OR NOT EXISTS (
          SELECT 1 FROM game_groups
          JOIN games ON games.id = game_groups.game_id
          JOIN group_members ON group_members.group_id = game_groups.id
          WHERE game_groups.guild_id = lfg_overlap_pairs.guild_id
            AND (game_groups.game_id = lfg_overlap_pairs.game_id OR games.provider_id = ?)
            AND group_members.user_id = lfg_overlap_pairs.user_b
            AND group_members.paused_at IS NULL
            AND julianday(group_members.expires_at) > julianday('now')
        )
      )
  `).bind(
    guildId,
    ...gameIds,
    ...gameIds,
    ANY_GAME_PROVIDER_ID,
    ANY_GAME_PROVIDER_ID,
    ANY_GAME_PROVIDER_ID,
  ).run();
}

async function claimNewOverlaps(
  db: D1Database,
  guildId: string,
  gameId: string,
  actorId: string,
): Promise<string[]> {
  const now = new Date().toISOString();
  const claimed = await db.prepare(`
    INSERT OR IGNORE INTO lfg_overlap_pairs (guild_id, game_id, user_a, user_b, created_at)
    SELECT ?, active.pairGameId,
      CASE WHEN ? < active.userId THEN ? ELSE active.userId END,
      CASE WHEN ? < active.userId THEN active.userId ELSE ? END,
      ?
    FROM (
      SELECT DISTINCT group_members.user_id AS userId,
        CASE
          WHEN target.provider_id = ? AND source_game.provider_id != ? THEN game_groups.game_id
          ELSE ?
        END AS pairGameId
      FROM games AS target
      JOIN game_groups ON game_groups.guild_id = ?
      JOIN games AS source_game ON source_game.id = game_groups.game_id
      JOIN group_members ON group_members.group_id = game_groups.id
      WHERE target.id = ?
        AND (
          game_groups.game_id = ?
          OR source_game.provider_id = ?
          OR target.provider_id = ?
        )
        AND group_members.user_id != ?
        AND group_members.paused_at IS NULL
        AND julianday(group_members.expires_at) > julianday('now')
    ) AS active
    RETURNING CASE WHEN user_a = ? THEN user_b ELSE user_a END AS recipientUserId
  `).bind(
    guildId,
    actorId, actorId,
    actorId, actorId,
    now,
    ANY_GAME_PROVIDER_ID, ANY_GAME_PROVIDER_ID, gameId,
    guildId,
    gameId,
    gameId,
    ANY_GAME_PROVIDER_ID,
    ANY_GAME_PROVIDER_ID,
    actorId,
    actorId,
  ).all<ClaimedOverlap>();
  return [...new Set(claimed.results.map((row) => row.recipientUserId))];
}

export async function upsertGameMembership(
  db: D1Database,
  guildId: string,
  channelId: string,
  userId: string,
  game: Game,
  requestedExpiry: Date,
): Promise<MembershipUpdate> {
  const group = await ensureGameGroup(db, guildId, game.id, channelId);
  await pruneInactiveOverlapPairs(db, guildId, [game.id]);
  const before = await loadGroupMember(db, group.id, userId);
  const wasActive = groupMemberState(before) === "active";
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO group_members (group_id, user_id, expires_at, paused_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(group_id, user_id) DO UPDATE SET
      expires_at = CASE
        WHEN julianday(excluded.expires_at) > julianday(group_members.expires_at) THEN excluded.expires_at
        ELSE group_members.expires_at
      END,
      paused_at = NULL,
      updated_at = excluded.updated_at
  `).bind(group.id, userId, requestedExpiry.toISOString(), now).run();
  const member = await loadGroupMember(db, group.id, userId);
  const recipients = wasActive ? [] : await claimNewOverlaps(db, guildId, game.id, userId);
  const snapshot = await loadGameGroupSnapshot(db, guildId, game.id);
  if (!snapshot) throw new Error("Could not load the game group.");
  return { snapshot, member, newlyOverlapping: recipients.length > 0, recipients };
}

export async function mutateGameMembership(
  db: D1Database,
  guildId: string,
  gameId: string,
  userId: string,
  action: "pause" | "resume" | "stop",
): Promise<MembershipUpdate> {
  const group = await loadGameGroup(db, guildId, gameId);
  if (!group) throw new Error("That game group no longer exists.");
  const member = await loadGroupMember(db, group.id, userId);
  const state = groupMemberState(member);
  if (state === "missing" || state === "expired") throw new Error("You are no longer looking for this game.");
  const now = new Date().toISOString();

  if (action === "pause") {
    if (state !== "active") throw new Error("You are already paused for this game.");
    const update = await db.prepare(`
      UPDATE group_members SET paused_at = ?, updated_at = ?
      WHERE group_id = ? AND user_id = ? AND paused_at IS NULL
        AND julianday(expires_at) > julianday('now')
    `).bind(now, now, group.id, userId).run();
    if (!update.meta.changes) throw new Error("Your LFG state changed before the pause completed.");
  } else if (action === "resume") {
    if (state !== "paused") throw new Error("You are not paused for this game.");
    await pruneInactiveOverlapPairs(db, guildId, [gameId]);
    const update = await db.prepare(`
      UPDATE group_members SET paused_at = NULL, updated_at = ?
      WHERE group_id = ? AND user_id = ? AND paused_at IS NOT NULL
        AND julianday(expires_at) > julianday('now')
    `).bind(now, group.id, userId).run();
    if (!update.meta.changes) throw new Error("Your LFG state changed before the resume completed.");
  } else {
    const deleted = await db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
      .bind(group.id, userId).run();
    if (!deleted.meta.changes) throw new Error("You are no longer looking for this game.");
  }

  await pruneInactiveOverlapPairs(db, guildId, [gameId]);
  const recipients = action === "resume" ? await claimNewOverlaps(db, guildId, gameId, userId) : [];
  const snapshot = await loadGameGroupSnapshot(db, guildId, gameId);
  if (!snapshot) throw new Error("Could not reload the game group.");
  return {
    snapshot,
    member: action === "stop" ? undefined : await loadGroupMember(db, group.id, userId),
    newlyOverlapping: recipients.length > 0,
    recipients,
  };
}

export async function ensureGroupsForUpcomingEvents(db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO game_groups (id, guild_id, game_id, channel_id)
    SELECT events.guild_id || ':' || event_games.game_id,
      events.guild_id, event_games.game_id, events.channel_id
    FROM events
    JOIN event_games ON event_games.event_id = events.id
    WHERE events.deleted_at IS NULL
      AND events.starts_at IS NOT NULL
      AND julianday(events.starts_at) > julianday('now')
      AND julianday(events.starts_at) <= julianday('now', '+1 hour')
  `).run();
}

export async function pruneExpiredGroupMembers(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM group_members WHERE julianday(expires_at) <= julianday('now')").run();
  await db.prepare(`
    DELETE FROM lfg_overlap_pairs
    WHERE NOT EXISTS (
      SELECT 1 FROM game_groups
      JOIN games ON games.id = game_groups.game_id
      JOIN group_members ON group_members.group_id = game_groups.id
      WHERE game_groups.guild_id = lfg_overlap_pairs.guild_id
        AND (game_groups.game_id = lfg_overlap_pairs.game_id OR games.provider_id = ?)
        AND group_members.user_id = lfg_overlap_pairs.user_a
        AND group_members.paused_at IS NULL
        AND julianday(group_members.expires_at) > julianday('now')
    ) OR NOT EXISTS (
      SELECT 1 FROM game_groups
      JOIN games ON games.id = game_groups.game_id
      JOIN group_members ON group_members.group_id = game_groups.id
      WHERE game_groups.guild_id = lfg_overlap_pairs.guild_id
        AND (game_groups.game_id = lfg_overlap_pairs.game_id OR games.provider_id = ?)
        AND group_members.user_id = lfg_overlap_pairs.user_b
        AND group_members.paused_at IS NULL
        AND julianday(group_members.expires_at) > julianday('now')
    )
  `).bind(ANY_GAME_PROVIDER_ID, ANY_GAME_PROVIDER_ID).run();
}

export async function listGameGroups(db: D1Database): Promise<GameGroup[]> {
  const rows = await db.prepare(`
    SELECT id, guild_id AS guildId, game_id AS gameId, channel_id AS channelId,
      discord_message_id AS discordMessageId, panel_claim_token AS panelClaimToken,
      panel_claimed_at AS panelClaimedAt
    FROM game_groups
  `).all<GameGroup>();
  return rows.results;
}

export async function claimPanelCreation(
  db: D1Database,
  groupId: string,
  channelId: string,
  token: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE game_groups
    SET panel_claim_token = ?, panel_claimed_at = ?, channel_id = ?
    WHERE id = ? AND discord_message_id IS NULL
      AND (
        panel_claim_token IS NULL OR panel_claimed_at IS NULL
        OR julianday(panel_claimed_at) <= julianday('now', '-2 minutes')
      )
  `).bind(token, now, channelId, groupId).run();
  return Boolean(result.meta.changes);
}

export async function savePanelMessage(
  db: D1Database,
  groupId: string,
  token: string,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE game_groups
    SET discord_message_id = ?, channel_id = ?, panel_claim_token = NULL, panel_claimed_at = NULL
    WHERE id = ? AND discord_message_id IS NULL AND panel_claim_token = ?
  `).bind(messageId, channelId, groupId, token).run();
  return Boolean(result.meta.changes);
}

export async function releasePanelClaim(db: D1Database, groupId: string, token: string): Promise<void> {
  await db.prepare(`
    UPDATE game_groups SET panel_claim_token = NULL, panel_claimed_at = NULL
    WHERE id = ? AND panel_claim_token = ?
  `).bind(groupId, token).run();
}

export async function clearPanelMessage(db: D1Database, groupId: string, messageId: string): Promise<void> {
  await db.prepare(`
    UPDATE game_groups
    SET discord_message_id = NULL, panel_claim_token = NULL, panel_claimed_at = NULL
    WHERE id = ? AND discord_message_id = ?
  `).bind(groupId, messageId).run();
}

export async function legacyLfgCards(db: D1Database): Promise<Array<{ id: string; channelId: string; messageId: string }>> {
  const rows = await db.prepare(`
    SELECT id, channel_id AS channelId, discord_message_id AS messageId
    FROM lfgs WHERE discord_message_id IS NOT NULL
  `).all<{ id: string; channelId: string; messageId: string }>();
  return rows.results;
}

export async function markLegacyLfgRetired(db: D1Database, lfgId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE lfgs SET discord_message_id = NULL,
      stopped_at = COALESCE(stopped_at, ?),
      finalized_at = COALESCE(finalized_at, ?)
    WHERE id = ?
  `).bind(now, now, lfgId).run();
}