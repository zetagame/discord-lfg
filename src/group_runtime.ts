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

const ANY_GAME_PROVIDER_ID = "system:any";

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

  // The D1 membership write has committed at this point. Start the public
  // projection immediately and independently from private control bookkeeping.
  for (const update of updates) {
    ctx.waitUntil(projectGamePanelAfterWrite(
      env,
      update.snapshot.group.guildId,
      update.snapshot.game.id,
      i.channel_id,
    ).catch((error) => console.error("Write-complete LFG panel projection failed", error)));
  }

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
    let controlGame = snapshot.game;
    let controlMember = member;
    let controlGameId = gameId;
    if (state === "missing" || state === "expired") {
      const wildcard = await activeAnyMembership(env.DB, i.guild_id, actor);
      if (!wildcard) return ephemeral(`You're not currently in **${snapshot.game.name}**. Use /lfg to join or extend the group.`);
      controlGame = wildcard.game;
      controlMember = wildcard.member;
      controlGameId = wildcard.game.id;
    }
    if (!i.application_id) return ephemeral("Could not open your LFG controls.");
    const session = await beginControlSession(env.DB, i.guild_id, controlGameId, actor, i.application_id, i.token);
    if (!session) return ephemeral("Your LFG controls are already opening.");
    ctx.waitUntil(finalizeOriginalControl(env, i, controlGameId, actor, session));
    return json({ type: ResponseType.ChannelMessage, data: { ...memberControlData(controlGame, controlMember), flags: 64 } });
  }

  if (action === "pause" && state !== "active") return ephemeral("You are not actively looking for this game.");
  if (action === "resume" && state !== "paused") return ephemeral("You are not paused for this game.");
  if (action === "stop" && state !== "active" && state !== "paused") return ephemeral("You are no longer looking for this game.");

  ctx.waitUntil(completeMemberAction(env, i, snapshot.game, action));
  return json({ type: ResponseType.UpdateMessage, data: memberControlData(snapshot.game, member, action) });
}

async function activeAnyMembership(
  db: D1Database,
  guildId: string,
  actor: string,
): Promise<{ game: Game; member: GroupMember } | undefined> {
  const row = await db.prepare(`
    SELECT games.id, games.name, games.provider_id AS providerId, games.cover_url AS coverUrl,
      group_members.expires_at AS expiresAt
    FROM games
    JOIN game_groups ON game_groups.game_id = games.id AND game_groups.guild_id = games.guild_id
    JOIN group_members ON group_members.group_id = game_groups.id
    WHERE games.guild_id = ? AND games.provider_id = ?
      AND group_members.user_id = ?
      AND group_members.paused_at IS NULL
      AND julianday(group_members.expires_at) > julianday('now')
    LIMIT 1
  `).bind(guildId, ANY_GAME_PROVIDER_ID, actor).first<Game & { expiresAt: string }>();
  if (!row) return undefined;
  return {
    game: { id: row.id, name: row.name, providerId: row.providerId, coverUrl: row.coverUrl },
    member: { userId: actor, expiresAt: row.expiresAt },
  };
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
    const panelProjection = projectGamePanelAfterWrite(env, i.guild_id!, game.id, i.channel_id)
      .catch((error) => console.error("Write-complete LFG panel projection failed", error));

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

    await panelProjection;
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
