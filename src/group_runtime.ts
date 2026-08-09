import { collectDeletedCustomGames } from "./games";
import {
  beginControlSession,
  cancelControlSessionOpening,
  promoteControlSession,
  pruneControlSessions,
  refreshControlSessionToken,
  takeControlSession,
  type LfgControlReference,
  type PendingControlSession,
} from "./control_sessions";
import { lfgMemberLines } from "./discord_presence";
import {
  claimPanelCreation,
  clearPanelMessage,
  ensureGameGroup,
  ensureGroupsForUpcomingEvents,
  groupMemberState,
  legacyLfgCards,
  listGameGroups,
  loadGameGroup,
  loadGameGroupSnapshot,
  loadGroupMember,
  markLegacyLfgRetired,
  mutateGameMembership,
  pruneExpiredGroupMembers,
  releasePanelClaim,
  savePanelMessage,
  upsertGameMembership,
  type GameGroupSnapshot,
  type GroupMember,
  type MembershipUpdate,
} from "./lfg";
import { ResponseType, json, userId } from "./discord";
import { discordTimestamp } from "./time";
import type { DiscordInteraction, Env, Game } from "./types";

type PanelEditResult = "updated" | "missing" | "retry";

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

  const first = updates[0];
  const primarySession = i.application_id
    ? await beginControlSession(env.DB, i.guild_id!, first.snapshot.game.id, actor, i.application_id, i.token)
    : undefined;
  ctx.waitUntil(afterMembershipUpdates(env, i, updates, actor, primarySession));

  return json({
    type: ResponseType.ChannelMessage,
    data: { ...memberControlData(first.snapshot.game, first.member, undefined, Boolean(primarySession)), flags: 64 },
  });
}

async function afterMembershipUpdates(
  env: Env,
  i: DiscordInteraction,
  updates: MembershipUpdate[],
  actor: string,
  primarySession?: PendingControlSession,
): Promise<void> {
  if (primarySession && i.application_id) {
    await finalizeOriginalControl(env, i, updates[0].snapshot.game.id, actor, primarySession);
  }
  for (const update of updates) await syncGamePanel(env, update.snapshot.group.guildId, update.snapshot.game.id, i.channel_id);
  await notifyGroupOverlaps(env, i.channel_id!, actor, updates);
  for (const update of updates.slice(1)) {
    await sendTrackedControlFollowup(env, i, update.snapshot.game, update.member, actor);
  }
}

export async function handleGroupComponent(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parts = i.data?.custom_id?.split(":") ?? [];
  const action = parts[1] as "manage" | "pause" | "resume" | "stop" | "busy" | undefined;
  const gameId = parts[2];
  const actor = userId(i);
  if (!i.guild_id || !actor || !gameId || !action || action === "busy") return ephemeral("This group action is not available.");

  const group = await loadGameGroup(env.DB, i.guild_id, gameId);
  const snapshot = await loadGameGroupSnapshot(env.DB, i.guild_id, gameId);
  if (!group || !snapshot) return ephemeral("That game group no longer exists.");
  const member = await loadGroupMember(env.DB, group.id, actor);
  const state = groupMemberState(member);

  if (action === "manage") {
    if (state === "missing" || state === "expired") return ephemeral(`You're not currently in **${snapshot.game.name}**. Use /lfg to join or extend the group.`);
    if (!i.application_id) return ephemeral("Could not open your LFG controls.");
    const session = await beginControlSession(env.DB, i.guild_id, gameId, actor, i.application_id, i.token);
    if (!session) return ephemeral("Your LFG controls are already opening.");
    ctx.waitUntil(finalizeOriginalControl(env, i, gameId, actor, session));
    return json({ type: ResponseType.ChannelMessage, data: { ...memberControlData(snapshot.game, member), flags: 64 } });
  }

  if (action === "pause" && state !== "active") return ephemeral("You are not actively looking for this game.");
  if (action === "resume" && state !== "paused") return ephemeral("You are not paused for this game.");
  if (action === "stop" && state !== "active" && state !== "paused") return ephemeral("You are no longer looking for this game.");

  ctx.waitUntil(completeMemberAction(env, i, snapshot.game, action));
  return json({ type: ResponseType.UpdateMessage, data: memberControlData(snapshot.game, member, action) });
}

async function finalizeOriginalControl(
  env: Env,
  i: DiscordInteraction,
  gameId: string,
  actor: string,
  pending: PendingControlSession,
): Promise<void> {
  if (!i.application_id || !i.guild_id) return;
  const messageId = await interactionOriginalMessageId(i.application_id, i.token);
  if (!messageId) {
    await deleteOriginalWebhookMessage(i.application_id, i.token);
    await cancelControlSessionOpening(env.DB, i.guild_id, gameId, actor, pending.nonce);
    return;
  }
  if (!await controlStillValid(env.DB, i.guild_id, gameId, actor)) {
    await deleteOriginalWebhookMessage(i.application_id, i.token);
    await cancelControlSessionOpening(env.DB, i.guild_id, gameId, actor, pending.nonce);
    return;
  }
  await finishControlOpening(
    env,
    i.guild_id,
    gameId,
    actor,
    pending,
    messageId,
    () => deleteOriginalWebhookMessage(i.application_id!, i.token),
  );
}

async function sendTrackedControlFollowup(
  env: Env,
  i: DiscordInteraction,
  game: Game,
  member: GroupMember | undefined,
  actor: string,
): Promise<void> {
  if (!i.application_id || !i.guild_id) return;
  const pending = await beginControlSession(env.DB, i.guild_id, game.id, actor, i.application_id, i.token);
  if (!pending) return;

  let messageId: string | undefined;
  try {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...memberControlData(game, member), flags: 64 }),
    });
    if (!response.ok) {
      console.error("Discord tracked control followup failed", response.status, await response.text());
      await cancelControlSessionOpening(env.DB, i.guild_id, game.id, actor, pending.nonce);
      return;
    }
    messageId = (await response.json() as { id?: string }).id;
    if (!messageId || !await controlStillValid(env.DB, i.guild_id, game.id, actor)) {
      if (messageId) await deleteWebhookMessage(i.application_id, i.token, messageId);
      await cancelControlSessionOpening(env.DB, i.guild_id, game.id, actor, pending.nonce);
      return;
    }
    await finishControlOpening(
      env,
      i.guild_id,
      game.id,
      actor,
      pending,
      messageId,
      () => deleteWebhookMessage(i.application_id!, i.token, messageId!),
    );
  } catch (error) {
    console.error("Discord tracked control followup request failed", error);
    if (messageId) await deleteWebhookMessage(i.application_id, i.token, messageId);
    await cancelControlSessionOpening(env.DB, i.guild_id, game.id, actor, pending.nonce);
  }
}

async function controlStillValid(db: D1Database, guildId: string, gameId: string, actor: string): Promise<boolean> {
  const group = await loadGameGroup(db, guildId, gameId);
  if (!group) return false;
  const member = await loadGroupMember(db, group.id, actor);
  const state = groupMemberState(member);
  return state === "active" || state === "paused";
}

async function finishControlOpening(
  env: Env,
  guildId: string,
  gameId: string,
  actor: string,
  pending: PendingControlSession,
  messageId: string,
  deleteNew: () => Promise<boolean>,
): Promise<boolean> {
  if (pending.previous && !await deleteStoredControlMessage(pending.previous)) {
    await deleteNew();
    await cancelControlSessionOpening(env.DB, guildId, gameId, actor, pending.nonce);
    return false;
  }
  const promoted = await promoteControlSession(env.DB, guildId, gameId, actor, pending.nonce, messageId);
  if (promoted) return true;
  await deleteNew();
  return false;
}

async function completeMemberAction(
  env: Env,
  i: DiscordInteraction,
  game: Game,
  action: "pause" | "resume" | "stop",
): Promise<void> {
  const actor = userId(i)!;
  try {
    const result = await mutateGameMembership(env.DB, i.guild_id!, game.id, actor, action);
    if (action === "stop") {
      const current = await takeControlSession(env.DB, i.guild_id!, game.id, actor);
      const clickedMessageId = i.message?.id;
      if (!await deleteInteractionOriginal(i)) {
        await editInteractionOriginal(i, memberControlData(game, undefined, undefined, false));
      }
      if (current && current.messageId !== clickedMessageId) await deleteStoredControlMessage(current);
    } else {
      await refreshControlSessionToken(env.DB, i.guild_id!, game.id, actor, i.message?.id, i.application_id, i.token);
      if (!await editInteractionOriginal(i, memberControlData(game, result.member))) {
        await interactionFollowup(i, "Your LFG state changed, but Discord could not refresh your controls.");
      }
    }
    await syncGamePanel(env, i.guild_id!, game.id, i.channel_id);
    if (action === "resume") await notifyGroupOverlaps(env, i.channel_id!, actor, [result]);
    if (action === "stop") await collectDeletedCustomGames(env.DB);
  } catch (error) {
    const group = await loadGameGroup(env.DB, i.guild_id!, game.id);
    const member = group ? await loadGroupMember(env.DB, group.id, actor) : undefined;
    await editInteractionOriginal(i, memberControlData(game, member));
    await interactionFollowup(i, error instanceof Error ? error.message : "Could not update your LFG state.");
  }
}

function memberControlData(
  game: Game,
  member?: GroupMember,
  loadingAction?: "pause" | "resume" | "stop",
  showControls = true,
): Record<string, unknown> {
  const state = groupMemberState(member);
  const status = loadingAction
    ? `${loadingAction === "pause" ? "Pausing" : loadingAction === "resume" ? "Resuming" : "Stopping"}…`
    : state === "active" ? `Looking until ${discordTimestamp(new Date(member!.expiresAt))}`
      : state === "paused" ? `Paused until ${discordTimestamp(new Date(member!.expiresAt))}`
        : "Not looking";
  const primary = state === "paused"
    ? { type: 2, style: 1, label: "▶ Resume", custom_id: `group:resume:${game.id}` }
    : { type: 2, style: 1, label: "⏸ Pause", custom_id: `group:pause:${game.id}` };
  const components = showControls && (state === "active" || state === "paused")
    ? [{
      type: 1,
      components: loadingAction === "stop"
        ? [
          { ...primary, disabled: true },
          { type: 2, style: 4, label: "⏳ Stopping…", custom_id: `group:busy:${game.id}`, disabled: true },
        ]
        : loadingAction
          ? [
            { type: 2, style: 1, label: `⏳ ${status}`, custom_id: `group:busy:${game.id}`, disabled: true },
            { type: 2, style: 4, label: "■ Stop", custom_id: `group:stop:${game.id}`, disabled: true },
          ]
          : [primary, { type: 2, style: 4, label: "■ Stop", custom_id: `group:stop:${game.id}` }],
    }]
    : [];
  return {
    embeds: [{
      title: game.name,
      description: status,
      thumbnail: game.coverUrl ? { url: game.coverUrl } : undefined,
    }],
    components,
  };
}

async function gamePanelData(env: Env, snapshot: GameGroupSnapshot): Promise<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  const members = await lfgMemberLines(env, snapshot.group.guildId, snapshot.activeUserIds);
  if (members.length) {
    fields.push({ name: "In group", value: embedValue(members.join("\n")), inline: false });
  }
  if (snapshot.upcomingEvent) {
    fields.push({
      name: "Upcoming event",
      value: `**${snapshot.upcomingEvent.title}** · ${discordTimestamp(new Date(snapshot.upcomingEvent.startsAt))}\n${snapshot.upcomingEvent.yesCount} going`,
      inline: false,
    });
  }
  return {
    embeds: [{
      title: snapshot.game.name,
      description: `**${snapshot.activeUserIds.length} in group**`,
      fields,
      thumbnail: snapshot.game.coverUrl ? { url: snapshot.game.coverUrl } : undefined,
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 2, label: "Manage my LFG", custom_id: `group:manage:${snapshot.game.id}` }],
    }],
  };
}

function embedValue(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1021)}…`;
}

function panelEligible(snapshot: GameGroupSnapshot): boolean {
  return snapshot.activeUserIds.length > 0 || Boolean(snapshot.upcomingEvent);
}

export async function syncGamePanel(env: Env, guildId: string, gameId: string, preferredChannelId?: string): Promise<void> {
  let snapshot = await loadGameGroupSnapshot(env.DB, guildId, gameId);
  if (!snapshot) return;
  const eligible = panelEligible(snapshot);
  const panelChannel = snapshot.activeUserIds.length > 0
    ? snapshot.group.channelId ?? preferredChannelId ?? snapshot.upcomingEvent?.channelId
    : snapshot.upcomingEvent?.channelId ?? snapshot.group.channelId ?? preferredChannelId;

  if (!eligible) {
    if (snapshot.group.discordMessageId && snapshot.group.channelId) {
      const latest = await loadGameGroupSnapshot(env.DB, guildId, gameId);
      if (latest && panelEligible(latest)) {
        await syncGamePanel(env, guildId, gameId, preferredChannelId);
        return;
      }
      const messageId = snapshot.group.discordMessageId;
      const deleted = await deleteChannelMessage(env, snapshot.group.channelId, messageId);
      if (deleted) {
        await clearPanelMessage(env.DB, snapshot.group.id, messageId);
        const afterDelete = await loadGameGroupSnapshot(env.DB, guildId, gameId);
        if (afterDelete && panelEligible(afterDelete)) {
          await syncGamePanel(env, guildId, gameId, preferredChannelId);
        }
      }
    }
    return;
  }
  if (!panelChannel) return;

  if (snapshot.group.discordMessageId && snapshot.group.channelId) {
    const edit = await editChannelMessage(env, snapshot.group.channelId, snapshot.group.discordMessageId, await gamePanelData(env, snapshot));
    if (edit === "updated") return;
    if (edit === "retry") return;
    await clearPanelMessage(env.DB, snapshot.group.id, snapshot.group.discordMessageId);
    snapshot = (await loadGameGroupSnapshot(env.DB, guildId, gameId)) ?? snapshot;
  }

  const claim = crypto.randomUUID();
  if (!await claimPanelCreation(env.DB, snapshot.group.id, panelChannel, claim)) return;
  let createdMessageId: string | undefined;
  try {
    const response = await postChannelMessage(env, panelChannel, await gamePanelData(env, snapshot));
    if (!response?.ok) return;
    const body = await response.json() as { id?: string };
    if (!body.id) return;
    createdMessageId = body.id;
    const saved = await savePanelMessage(env.DB, snapshot.group.id, claim, panelChannel, body.id);
    if (!saved) {
      await deleteChannelMessage(env, panelChannel, body.id);
      createdMessageId = undefined;
    }
  } catch (error) {
    console.error("Shared panel creation failed", error);
    if (createdMessageId) await deleteChannelMessage(env, panelChannel, createdMessageId);
  } finally {
    await releasePanelClaim(env.DB, snapshot.group.id, claim);
  }
}

export async function syncSharedGameGroups(env: Env): Promise<void> {
  await pruneExpiredGroupMembers(env.DB);
  await pruneControlSessions(env.DB);
  await ensureGroupsForUpcomingEvents(env.DB);
  await retireLegacyLfgCards(env);
  const groups = await listGameGroups(env.DB);
  for (const group of groups) await syncGamePanel(env, group.guildId, group.gameId, group.channelId);
}

export async function syncGamePanelsForEvent(env: Env, eventId: string, ensureGroups = true): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT events.guild_id AS guildId, events.channel_id AS channelId, event_games.game_id AS gameId
    FROM events JOIN event_games ON event_games.event_id = events.id
    WHERE events.id = ?
  `).bind(eventId).all<{ guildId: string; channelId: string; gameId: string }>();
  for (const row of rows.results) {
    if (ensureGroups) await ensureGameGroup(env.DB, row.guildId, row.gameId, row.channelId);
    await syncGamePanel(env, row.guildId, row.gameId, row.channelId);
  }
}

async function retireLegacyLfgCards(env: Env): Promise<void> {
  const cards = await legacyLfgCards(env.DB);
  for (const card of cards) {
    if (await deleteChannelMessage(env, card.channelId, card.messageId)) await markLegacyLfgRetired(env.DB, card.id);
  }
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

async function editChannelMessage(
  env: Env,
  channelId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<PanelEditResult> {
  if (!env.DISCORD_BOT_TOKEN) return "retry";
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return "updated";
    const detail = await response.text();
    if (response.status === 404) {
      console.warn("Discord group panel is missing", messageId, detail);
      return "missing";
    }
    console.error("Discord group panel edit failed", response.status, detail);
    return "retry";
  } catch (error) {
    console.error("Discord group panel edit request failed", error);
    return "retry";
  }
}

async function deleteChannelMessage(env: Env, channelId: string, messageId: string): Promise<boolean> {
  if (!env.DISCORD_BOT_TOKEN) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (!response.ok && response.status !== 404) console.error("Discord group panel delete failed", response.status, await response.text());
    return response.ok || response.status === 404;
  } catch (error) {
    console.error("Discord group panel delete request failed", error);
    return false;
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
      body: JSON.stringify({ content, flags: 64 }),
    });
    if (!response.ok) console.error("Discord interaction followup failed", response.status, await response.text());
  } catch (error) {
    console.error("Discord interaction followup request failed", error);
  }
}

function ephemeral(content: string): Response {
  return json({ type: ResponseType.ChannelMessage, data: { content, flags: 64 } });
}
