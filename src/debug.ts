import { ResponseType, userId } from "./discord";
import type { DiscordInteraction, Env } from "./types";

const EPHEMERAL = 1 << 6;
const MAX_ROWS = 25;

export const debugCommand = {
  name: "debug",
  description: "Show authoritative LFG and event state",
  default_member_permissions: "32",
};

type LfgRow = {
  game: string;
  userId: string;
  expiresAt: string;
  pausedAt?: string;
  groupId: string;
  channelId?: string;
  messageId?: string;
  panelRevision?: number;
  panelAppliedRevision?: number;
  panelLastError?: string;
};

type EventRow = {
  id: string;
  title: string;
  startsAt?: string;
  whenInput?: string;
  authorId: string;
  channelId: string;
  deletedAt?: string;
  games?: string;
  yesCount: number;
  maybeCount: number;
  noCount: number;
  deliveries?: string;
};

function canManageGuild(i: DiscordInteraction): boolean {
  try {
    const permissions = BigInt(i.member?.permissions ?? "0");
    return (permissions & 8n) !== 0n || (permissions & 32n) !== 0n;
  } catch {
    return false;
  }
}

function shortId(value?: string): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function discordTime(value?: string): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : value;
}

function trim(value: string, max = 1000): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export async function handleDebugCommand(i: DiscordInteraction, env: Env): Promise<Response> {
  if (!i.guild_id || !userId(i)) return ephemeral("Use /debug in a server.");
  if (!canManageGuild(i)) return ephemeral("Manage Server permission is required for /debug.");

  const [lfgs, events] = await Promise.all([
    env.DB.prepare(`
      SELECT games.name AS game,
        group_members.user_id AS userId,
        group_members.expires_at AS expiresAt,
        group_members.paused_at AS pausedAt,
        game_groups.id AS groupId,
        game_groups.channel_id AS channelId,
        game_groups.discord_message_id AS messageId,
        game_groups.panel_revision AS panelRevision,
        game_groups.panel_applied_revision AS panelAppliedRevision,
        game_groups.panel_last_error AS panelLastError
      FROM group_members
      JOIN game_groups ON game_groups.id = group_members.group_id
      JOIN games ON games.id = game_groups.game_id
      WHERE game_groups.guild_id = ?
      ORDER BY group_members.expires_at DESC
      LIMIT ?
    `).bind(i.guild_id, MAX_ROWS).all<LfgRow>(),
    env.DB.prepare(`
      SELECT events.id,
        events.title,
        events.starts_at AS startsAt,
        events.when_input AS whenInput,
        events.author_id AS authorId,
        events.channel_id AS channelId,
        events.deleted_at AS deletedAt,
        GROUP_CONCAT(DISTINCT games.name) AS games,
        SUM(CASE WHEN rsvps.status = 'yes' THEN 1 ELSE 0 END) AS yesCount,
        SUM(CASE WHEN rsvps.status = 'maybe' THEN 1 ELSE 0 END) AS maybeCount,
        SUM(CASE WHEN rsvps.status = 'no' THEN 1 ELSE 0 END) AS noCount,
        (
          SELECT GROUP_CONCAT(event_deliveries.kind || ':' || event_deliveries.user_id || '@' || event_deliveries.delivered_at)
          FROM event_deliveries
          WHERE event_deliveries.event_id = events.id
        ) AS deliveries
      FROM events
      LEFT JOIN event_games ON event_games.event_id = events.id
      LEFT JOIN games ON games.id = event_games.game_id
      LEFT JOIN rsvps ON rsvps.event_id = events.id
      WHERE events.guild_id = ?
      GROUP BY events.id
      ORDER BY COALESCE(events.starts_at, events.deleted_at, events.when_input) DESC
      LIMIT ?
    `).bind(i.guild_id, MAX_ROWS).all<EventRow>(),
  ]);

  const now = Date.now();
  const lfgText = lfgs.results.length
    ? lfgs.results.map((row) => {
        const expired = Date.parse(row.expiresAt) <= now;
        const state = expired ? "expired" : row.pausedAt ? "paused" : "active";
        const panel = row.messageId ? `panel ${shortId(row.messageId)}` : "no panel";
        const revision = `${row.panelAppliedRevision ?? 0}/${row.panelRevision ?? 0}`;
        const error = row.panelLastError ? ` · error: ${trim(row.panelLastError, 120)}` : "";
        return `**${row.game}** · ${state} · <@${row.userId}>\nuntil ${discordTime(row.expiresAt)} · group ${shortId(row.groupId)} · ${panel} · rev ${revision}${error}`;
      }).join("\n\n")
    : "None.";

  const eventText = events.results.length
    ? events.results.map((row) => {
        const state = row.deletedAt ? `DELETED ${discordTime(row.deletedAt)}` : "active";
        const identity = row.games || row.title || "Untitled event";
        const timing = row.startsAt ? discordTime(row.startsAt) : row.whenInput || "—";
        const delivery = row.deliveries ? trim(row.deliveries, 180) : "none";
        return `**${identity}** · ${state}\nevent \`${row.id}\` · creator <@${row.authorId}> · when ${timing}\nRSVP ${row.yesCount ?? 0} yes / ${row.maybeCount ?? 0} maybe / ${row.noCount ?? 0} no · deliveries: ${delivery}`;
      }).join("\n\n")
    : "None.";

  return Response.json({
    type: ResponseType.ChannelMessage,
    data: {
      flags: EPHEMERAL,
      embeds: [{
        title: "LFG diagnostics",
        description: "Authoritative D1 state for this server. Deleted events are intentionally included.",
        fields: [
          { name: `LFGs (${lfgs.results.length}${lfgs.results.length === MAX_ROWS ? "+" : ""})`, value: trim(lfgText), inline: false },
          { name: `Events (${events.results.length}${events.results.length === MAX_ROWS ? "+" : ""})`, value: trim(eventText), inline: false },
        ],
        footer: { text: "IDs are shown for tracing notifications and stale Discord UI." },
      }],
    },
  });
}

function ephemeral(content: string): Response {
  return Response.json({ type: ResponseType.ChannelMessage, data: { content, flags: EPHEMERAL } });
}
