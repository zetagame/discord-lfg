import { collectDeletedCustomGames } from "./games";
import {
  beginControlSession,
  cancelControlSessionOpening,
  promoteControlSession,
  refreshControlSessionToken,
  takeControlSession,
  type LfgControlReference,
  type PendingControlSession,
} from "./control_sessions";
import {
  groupMemberState,
  loadGameGroup,
  loadGameGroupSnapshot,
  loadGroupMember,
  mutateGameMembership,
  upsertGameMembership,
  type GroupMember,
  type MembershipUpdate,
} from "./lfg";
import { projectGamePanelAfterWrite } from "./panel_sync";
import { ResponseType, json, userId } from "./discord";
import { discordTimestamp } from "./time";
import type { DiscordInteraction, Env, Game } from "./types";

const IS_COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;
const MAX_MANAGER_ROWS = 6;

type ManagerAction = "pause" | "resume" | "stop";
type ManagedLfg = { game: Game; member: GroupMember };

type LoadingState = {
  gameId: string;
  action: ManagerAction;
};

export { syncGamePanelsForEvent, syncSharedGameGroups } from "./panel_sync";

export async function handleLfgCommand(
  i: DiscordInteraction,
  env: Env,
  games: Game[],
  actor: string,
  expiresAt: Date,
  ctx: ExecutionContext,
): Promise<Response> {
  const updates: MembershipUpdate[] = [];
  for (const game of games) {
    updates.push(await upsertGameMembership(env.DB, i.guild_id!, i.channel_id!, actor, game, expiresAt));
  }
  if (!updates.length) return ephemeral("Choose at least one game.");

  // The membership write is durable before Discord projection starts. Await the
  // public projection here so a newly-created/updated group panel is ordered
  // before the private manager response. Discord retries remain isolated inside
  // the projector and never replay the D1 write.
  await Promise.all(updates.map((update) => projectGamePanelAfterWrite(
    env,
    update.snapshot.group.guildId,
    update.snapshot.game.id,
    i.channel_id,
  ).catch((error) => console.error("Write-complete LFG panel projection failed", error))));

  const manager = await loadManagedLfgs(env.DB, i.guild_id!, actor);
  const session = i.application_id
    ? await beginControlSession(env.DB, i.guild_id!, actor, i.application_id, i.token)
    : undefined;
  ctx.waitUntil(afterMembershipUpdates(env, i, updates, actor, session));

  return json({
    type: ResponseType.ChannelMessage,
    data: {
      ...managerData(manager, undefined, Boolean(session)),
      flags: EPHEMERAL | IS_COMPONENTS_V2,
    },
  });
}

async function afterMembershipUpdates(
  env: Env,
  i: DiscordInteraction,
  updates: MembershipUpdate[],
  actor: string,
  session?: PendingControlSession,
): Promise<void> {
  if (session && i.application_id) await finalizeOriginalControl(env, i, actor, session);
  await notifyGroupOverlaps(env, i.channel_id!, actor, updates);
}

export async function handleGroupComponent(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parts = i.data?.custom_id?.split(":") ?? [];
  const action = parts[1] as "manage" | ManagerAction | "busy" | undefined;
  const gameId = parts[2];
  const actor = userId(i);
  if (!i.guild_id || !actor || !gameId || !action || action === "busy") return ephemeral("This group action is not available.");

  if (action === "manage") {
    const manager = await loadManagedLfgs(env.DB, i.guild_id, actor);
    if (!manager.length) return ephemeral("You don't have any active LFGs. Use /lfg to start one.");
    if (!i.application_id) return ephemeral("Could not open your LFG controls.");
    const session = await beginControlSession(env.DB, i.guild_id, actor, i.application_id, i.token);
    if (!session) return ephemeral("Your LFG controls are already opening.");
    ctx.waitUntil(finalizeOriginalControl(env, i, actor, session));
    return json({
      type: ResponseType.ChannelMessage,
      data: { ...managerData(manager), flags: EPHEMERAL | IS_COMPONENTS_V2 },
    });
  }

  const group = await loadGameGroup(env.DB, i.guild_id, gameId);
  const snapshot = await loadGameGroupSnapshot(env.DB, i.guild_id, gameId);
  if (!group || !snapshot) return ephemeral("That game group no longer exists.");
  const member = await loadGroupMember(env.DB, group.id, actor);
  const state = groupMemberState(member);

  if (action === "pause" && state !== "active") return ephemeral("You are not actively looking for this game.");
  if (action === "resume" && state !== "paused") return ephemeral("You are not paused for this game.");
  if (action === "stop" && state !== "active" && state !== "paused") return ephemeral("You are no longer looking for this game.");

  const manager = await loadManagedLfgs(env.DB, i.guild_id, actor);
  ctx.waitUntil(completeMemberAction(env, i, snapshot.game, action));
  return json({
    type: ResponseType.UpdateMessage,
    data: managerData(manager, { gameId, action }),
  });
}

async function loadManagedLfgs(db: D1Database, guildId: string, actor: string): Promise<ManagedLfg[]> {
  const rows = await db.prepare(`
    SELECT games.id, games.name, games.provider_id AS providerId, games.cover_url AS coverUrl,
      games.created_by_user_id AS createdByUserId,
      group_members.expires_at AS expiresAt, group_members.paused_at AS pausedAt
    FROM group_members
    JOIN game_groups ON game_groups.id = group_members.group_id
    JOIN games ON games.id = game_groups.game_id
    WHERE game_groups.guild_id = ?
      AND group_members.user_id = ?
      AND julianday(group_members.expires_at) > julianday('now')
    ORDER BY games.name COLLATE NOCASE
  `).bind(guildId, actor).all<Game & { expiresAt: string; pausedAt?: string }>();
  return rows.results.map((row) => ({
    game: {
      id: row.id,
      name: row.name,
      providerId: row.providerId,
      coverUrl: row.coverUrl,
      createdByUserId: row.createdByUserId,
    },
    member: { userId: actor, expiresAt: row.expiresAt, pausedAt: row.pausedAt },
  }));
}

async function finalizeOriginalControl(
  env: Env,
  i: DiscordInteraction,
  actor: string,
  pending: PendingControlSession,
): Promise<void> {
  if (!i.application_id || !i.guild_id) return;
  const messageId = await interactionOriginalMessageId(i.application_id, i.token);
  if (!messageId) {
    await deleteOriginalWebhookMessage(i.application_id, i.token);
    await cancelControlSessionOpening(env.DB, i.guild_id, actor, pending.nonce);
    return;
  }
  if (!await controlStillValid(env.DB, i.guild_id, actor)) {
    await deleteOriginalWebhookMessage(i.application_id, i.token);
    await cancelControlSessionOpening(env.DB, i.guild_id, actor, pending.nonce);
    return;
  }
  await finishControlOpening(
    env,
    i.guild_id,
    actor,
    pending,
    messageId,
    () => deleteOriginalWebhookMessage(i.application_id!, i.token),
  );
}

async function controlStillValid(db: D1Database, guildId: string, actor: string): Promise<boolean> {
  return (await loadManagedLfgs(db, guildId, actor)).length > 0;
}

async function finishControlOpening(
  env: Env,
  guildId: string,
  actor: string,
  pending: PendingControlSession,
  messageId: string,
  deleteNew: () => Promise<boolean>,
): Promise<boolean> {
  if (pending.previous && !await deleteStoredControlMessage(pending.previous)) {
    await deleteNew();
    await cancelControlSessionOpening(env.DB, guildId, actor, pending.nonce);
    return false;
  }
  const promoted = await promoteControlSession(env.DB, guildId, actor, pending.nonce, messageId);
  if (promoted) return true;
  await deleteNew();
  return false;
}

async function completeMemberAction(
  env: Env,
  i: DiscordInteraction,
  game: Game,
  action: ManagerAction,
): Promise<void> {
  const actor = userId(i)!;
  try {
    const result = await mutateGameMembership(env.DB, i.guild_id!, game.id, actor, action);
    const panelProjection = projectGamePanelAfterWrite(env, i.guild_id!, game.id, i.channel_id)
      .catch((error) => console.error("Write-complete LFG panel projection failed", error));
    const manager = await loadManagedLfgs(env.DB, i.guild_id!, actor);

    // Keep one authoritative manager alive while any LFG remains. A new manager
    // supersedes it through the control-session opening path above; only the last
    // Stop removes the current manager.
    if (!manager.length) {
      const current = await takeControlSession(env.DB, i.guild_id!, actor);
      const clickedMessageId = i.message?.id;
      if (!await deleteInteractionOriginal(i)) {
        await editInteractionOriginal(i, managerData([]));
      }
      if (current && current.messageId !== clickedMessageId) await deleteStoredControlMessage(current);
    } else {
      await refreshControlSessionToken(env.DB, i.guild_id!, actor, i.message?.id, i.application_id, i.token);
      if (!await editInteractionOriginal(i, managerData(manager))) {
        await interactionFollowup(i, "Your LFG state changed, but Discord could not refresh your controls.");
      }
    }

    await panelProjection;
    if (action === "resume") await notifyGroupOverlaps(env, i.channel_id!, actor, [result]);
    if (action === "stop") await collectDeletedCustomGames(env.DB);
  } catch (error) {
    const manager = await loadManagedLfgs(env.DB, i.guild_id!, actor);
    await editInteractionOriginal(i, managerData(manager));
    await interactionFollowup(i, error instanceof Error ? error.message : "Could not update your LFG state.");
  }
}

function managerData(
  managed: ManagedLfg[],
  loading?: LoadingState,
  showControls = true,
): Record<string, unknown> {
  const visible = managed.slice(0, MAX_MANAGER_ROWS);
  const components: Record<string, unknown>[] = [
    { type: 10, content: "### Your LFGs" },
  ];

  for (const [index, { game, member }] of visible.entries()) {
    const state = groupMemberState(member);
    const loadingThis = loading?.gameId === game.id;
    const primaryLabel = state === "paused" ? "▶ Resume" : "⏸ Pause";
    const primaryAction = state === "paused" ? "resume" : "pause";
    const status = loadingThis
      ? loading?.action === "pause" ? "Pausing…"
        : loading?.action === "resume" ? "Resuming…"
          : "Stopping…"
      : state === "paused"
        ? `Paused until ${discordTimestamp(new Date(member.expiresAt))}`
        : `Looking until ${discordTimestamp(new Date(member.expiresAt))}`;

    components.push({
      type: 10,
      content: `**${game.name}**\n-# ${status}`,
    });
    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: loadingThis && loading?.action !== "stop" ? `⏳ ${status}` : primaryLabel,
          custom_id: loadingThis ? `group:busy:${game.id}` : `group:${primaryAction}:${game.id}`,
          disabled: loadingThis || !showControls,
        },
        {
          type: 2,
          style: 4,
          label: loadingThis && loading?.action === "stop" ? "⏳ Stopping…" : "■ Stop",
          custom_id: loadingThis ? `group:busy:${game.id}` : `group:stop:${game.id}`,
          disabled: loadingThis || !showControls,
        },
      ],
    });
    if (index < visible.length - 1) {
      components.push({ type: 14, divider: true, spacing: 1 });
    }
  }

  if (managed.length > visible.length) {
    components.push({ type: 10, content: `-# Showing ${visible.length} of ${managed.length} LFGs.` });
  }
  if (!managed.length) components.push({ type: 10, content: "-# No active LFGs." });

  return {
    components: [{ type: 17, components }],
  };
}

async function notifyGroupOverlaps(env: Env, channelId: string, actor: string, updates: MembershipUpdate[]): Promise<void> {
  const overlapping = updates.filter((update) => update.newlyOverlapping && update.recipients.length);
  if (!overlapping.length) return;
  const recipients = [...new Set(overlapping.flatMap((update) => update.recipients))];
  const mentions = recipients.map((uid) => `<@${uid}>`).join(" ");
  const lines = overlapping.map((update) => `**${update.snapshot.game.name}** — ${update.snapshot.activeUserIds.length} in group`);
  await postChannelMessage(env, channelId, {
    content: `${mentions} New overlap with <@${actor}>:\n${lines.join("\n")}`,
    allowed_mentions: { users: recipients },
  });
}

async function postChannelMessage(env: Env, channelId: string, body: Record<string, unknown>): Promise<Response | undefined> {
  if (!env.DISCORD_BOT_TOKEN) return undefined;
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) console.error("Discord channel message failed", response.status, await response.text());
    return response;
  } catch (error) {
    console.error("Discord channel message request failed", error);
    return undefined;
  }
}

async function interactionOriginalMessageId(applicationId: string, token: string): Promise<string | undefined> {
  for (const delay of [0, 100, 250]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`);
      if (response.ok) return (await response.json() as { id?: string }).id;
      if (response.status === 404) continue;
      console.error("Discord interaction message lookup failed", response.status, await response.text());
      return undefined;
    } catch (error) {
      if (delay === 250) console.error("Discord interaction message lookup request failed", error);
    }
  }
  return undefined;
}

async function deleteStoredControlMessage(session: LfgControlReference): Promise<boolean> {
  return deleteWebhookMessage(session.applicationId, session.interactionToken, session.messageId);
}

async function deleteOriginalWebhookMessage(applicationId: string, token: string): Promise<boolean> {
  return deleteWebhookMessage(applicationId, token, "@original");
}

async function deleteWebhookMessage(applicationId: string, token: string, messageId: string): Promise<boolean> {
  for (const delay of [0, 150, 500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/${messageId}`, { method: "DELETE" });
      if (response.ok || response.status === 404) return true;
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        console.error("Discord control message delete failed", response.status, await response.text());
        return false;
      }
      if (delay === 500) console.error("Discord control message delete failed after retries", response.status, await response.text());
    } catch (error) {
      if (delay === 500) console.error("Discord control message delete request failed after retries", error);
    }
  }
  return false;
}

async function editInteractionOriginal(i: DiscordInteraction, body: Record<string, unknown>): Promise<boolean> {
  if (!i.application_id) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) console.error("Discord interaction edit failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error("Discord interaction edit request failed", error);
    return false;
  }
}

async function deleteInteractionOriginal(i: DiscordInteraction): Promise<boolean> {
  if (!i.application_id) return false;
  return deleteOriginalWebhookMessage(i.application_id, i.token);
}

async function interactionFollowup(i: DiscordInteraction, content: string): Promise<void> {
  if (!i.application_id) return;
  try {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, flags: EPHEMERAL }),
    });
    if (!response.ok) console.error("Discord interaction followup failed", response.status, await response.text());
  } catch (error) {
    console.error("Discord interaction followup request failed", error);
  }
}

function ephemeral(content: string): Response {
  return json({ type: ResponseType.ChannelMessage, data: { content, flags: EPHEMERAL } });
}
