import { actionAfter, PermanentActionError, RetryableActionError } from "./action_after";
import { pruneControlSessions } from "./control_sessions";
import { lfgMemberLines } from "./discord_presence";
import {
  claimPanelCreation,
  clearPanelMessage,
  ensureGameGroup,
  ensureGroupsForUpcomingEvents,
  legacyLfgCards,
  listGameGroups,
  loadGameGroup,
  loadGameGroupSnapshot,
  markLegacyLfgRetired,
  pruneExpiredGroupMembers,
  releasePanelClaim,
  savePanelMessage,
  type GameGroupSnapshot,
} from "./lfg";
import {
  clearPanelCreateNonce,
  ensurePanelCreateNonce,
  loadPanelProjectionState,
  markPanelProjectionApplied,
  recordPanelProjectionError,
} from "./panel_projection";
import { discordTimestamp } from "./time";
import type { Env } from "./types";

const PANEL_ATTEMPT_TIMEOUT_MS = 3000;
const PANEL_RETRIES = 2;

type PanelEditResult = "updated" | "missing";

export async function projectGamePanelAfterWrite(
  env: Env,
  guildId: string,
  gameId: string,
  preferredChannelId?: string,
): Promise<void> {
  const group = await loadGameGroup(env.DB, guildId, gameId);
  if (!group) return;
  try {
    await actionAfter(
      `LFG panel ${gameId}`,
      (signal) => syncGamePanelAttempt(env, guildId, gameId, preferredChannelId, signal),
      { timeoutMs: PANEL_ATTEMPT_TIMEOUT_MS, retries: PANEL_RETRIES },
    );
  } catch (error) {
    await recordPanelProjectionError(env.DB, group.id, error);
    throw error;
  }
}

export async function syncSharedGameGroups(env: Env): Promise<void> {
  await pruneExpiredGroupMembers(env.DB);
  await pruneControlSessions(env.DB);
  await ensureGroupsForUpcomingEvents(env.DB);
  await retireLegacyLfgCards(env);
  const groups = await listGameGroups(env.DB);
  for (const group of groups) {
    await bestEffortProjection(env, group.guildId, group.gameId, group.channelId);
  }
}

export async function syncGamePanelsForEvent(env: Env, eventId: string, ensureGroups = true): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT events.guild_id AS guildId, events.channel_id AS channelId, event_games.game_id AS gameId
    FROM events JOIN event_games ON event_games.event_id = events.id
    WHERE events.id = ?
  `).bind(eventId).all<{ guildId: string; channelId: string; gameId: string }>();
  for (const row of rows.results) {
    if (ensureGroups) await ensureGameGroup(env.DB, row.guildId, row.gameId, row.channelId);
    await bestEffortProjection(env, row.guildId, row.gameId, row.channelId);
  }
}

async function bestEffortProjection(env: Env, guildId: string, gameId: string, channelId?: string): Promise<void> {
  try {
    await projectGamePanelAfterWrite(env, guildId, gameId, channelId);
  } catch (error) {
    console.error("Shared LFG panel projection failed", guildId, gameId, error);
  }
}

async function syncGamePanelAttempt(
  env: Env,
  guildId: string,
  gameId: string,
  preferredChannelId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  let snapshot = await loadGameGroupSnapshot(env.DB, guildId, gameId);
  if (!snapshot) return;
  const projection = await loadPanelProjectionState(env.DB, snapshot.group.id);
  const targetRevision = projection?.revision ?? 0;
  const eligible = panelEligible(snapshot);
  const panelChannel = snapshot.activeUserIds.length > 0
    ? snapshot.group.channelId ?? preferredChannelId ?? snapshot.upcomingEvent?.channelId
    : snapshot.upcomingEvent?.channelId ?? snapshot.group.channelId ?? preferredChannelId;

  if (!eligible) {
    if (snapshot.group.discordMessageId && snapshot.group.channelId) {
      const latest = await loadGameGroupSnapshot(env.DB, guildId, gameId);
      if (latest && panelEligible(latest)) throw new RetryableActionError("Panel became eligible during deletion");
      await deletePanelMessage(env, snapshot.group.channelId, snapshot.group.discordMessageId, signal);
      await clearPanelMessage(env.DB, snapshot.group.id, snapshot.group.discordMessageId);
      await clearPanelCreateNonce(env.DB, snapshot.group.id);
    }
    await finishProjection(env, snapshot.group.id, targetRevision);
    return;
  }
  if (!panelChannel) throw new PermanentActionError("No Discord channel is available for the shared LFG panel.");

  if (snapshot.group.discordMessageId && snapshot.group.channelId) {
    const edit = await editPanelMessage(
      env,
      snapshot.group.channelId,
      snapshot.group.discordMessageId,
      await gamePanelData(env, snapshot, signal),
      signal,
    );
    if (edit === "updated") {
      await finishProjection(env, snapshot.group.id, targetRevision);
      return;
    }
    await clearPanelMessage(env.DB, snapshot.group.id, snapshot.group.discordMessageId);
    await clearPanelCreateNonce(env.DB, snapshot.group.id);
    snapshot = (await loadGameGroupSnapshot(env.DB, guildId, gameId)) ?? snapshot;
  }

  const claim = crypto.randomUUID();
  if (!await claimPanelCreation(env.DB, snapshot.group.id, panelChannel, claim)) {
    const current = await loadPanelProjectionState(env.DB, snapshot.group.id);
    if ((current?.appliedRevision ?? -1) >= targetRevision) return;
    throw new RetryableActionError("Another worker is projecting this panel", 100);
  }

  let createdMessageId: string | undefined;
  try {
    const nonce = await ensurePanelCreateNonce(env.DB, snapshot.group.id);
    const response = await createPanelMessage(
      env,
      panelChannel,
      { ...(await gamePanelData(env, snapshot, signal)), nonce, enforce_nonce: true },
      signal,
    );
    const body = await response.json() as { id?: string };
    if (!body.id) throw new RetryableActionError("Discord returned a panel response without a message id.");
    createdMessageId = body.id;
    const saved = await savePanelMessage(env.DB, snapshot.group.id, claim, panelChannel, body.id);
    if (!saved) {
      const current = await loadGameGroup(env.DB, guildId, gameId);
      if (current?.discordMessageId !== body.id) await deletePanelMessage(env, panelChannel, body.id, signal);
      if (!current?.discordMessageId) throw new RetryableActionError("Panel creation lost its D1 claim before the message id was saved.");
    }
    await clearPanelCreateNonce(env.DB, snapshot.group.id);
    await finishProjection(env, snapshot.group.id, targetRevision);
  } finally {
    await releasePanelClaim(env.DB, snapshot.group.id, claim);
  }
}

async function finishProjection(env: Env, groupId: string, targetRevision: number): Promise<void> {
  await markPanelProjectionApplied(env.DB, groupId, targetRevision);
  const latest = await loadPanelProjectionState(env.DB, groupId);
  if ((latest?.revision ?? targetRevision) > targetRevision) {
    throw new RetryableActionError("Panel state changed while it was being projected.");
  }
}

async function gamePanelData(env: Env, snapshot: GameGroupSnapshot, signal: AbortSignal): Promise<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  const members = await lfgMemberLines(env, snapshot.group.guildId, snapshot.activeUserIds, signal);
  if (members.length) fields.push({ name: "In group", value: embedValue(members.join("\n")), inline: false });
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

function panelEligible(snapshot: GameGroupSnapshot): boolean {
  return snapshot.activeUserIds.length > 0 || Boolean(snapshot.upcomingEvent);
}

function embedValue(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1021)}…`;
}

async function createPanelMessage(
  env: Env,
  channelId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN) throw new PermanentActionError("DISCORD_BOT_TOKEN is missing.");
  let response: Response;
  try {
    response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RetryableActionError(`Discord panel create request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) await throwDiscordFailure(response, "create shared LFG panel");
  return response;
}

async function editPanelMessage(
  env: Env,
  channelId: string,
  messageId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PanelEditResult> {
  if (!env.DISCORD_BOT_TOKEN) throw new PermanentActionError("DISCORD_BOT_TOKEN is missing.");
  let response: Response;
  try {
    response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RetryableActionError(`Discord panel edit request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.ok) return "updated";
  if (response.status === 404) return "missing";
  await throwDiscordFailure(response, "edit shared LFG panel");
}

async function deletePanelMessage(env: Env, channelId: string, messageId: string, signal: AbortSignal): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) throw new PermanentActionError("DISCORD_BOT_TOKEN is missing.");
  let response: Response;
  try {
    response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RetryableActionError(`Discord panel delete request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.ok || response.status === 404) return;
  await throwDiscordFailure(response, "delete shared LFG panel");
}

async function throwDiscordFailure(response: Response, action: string): Promise<never> {
  const detail = await response.text();
  if (response.status === 429) {
    let retryAfterMs = Number(response.headers.get("retry-after")) * 1000;
    try {
      const body = JSON.parse(detail) as { retry_after?: number };
      if (typeof body.retry_after === "number") retryAfterMs = body.retry_after * 1000;
    } catch {}
    throw new RetryableActionError(`Discord rate limited while trying to ${action}.`, Number.isFinite(retryAfterMs) ? retryAfterMs : 1000);
  }
  if (response.status >= 500) throw new RetryableActionError(`Discord ${action} failed (${response.status}): ${detail}`);
  throw new PermanentActionError(`Discord ${action} failed (${response.status}): ${detail}`);
}

async function retireLegacyLfgCards(env: Env): Promise<void> {
  const cards = await legacyLfgCards(env.DB);
  for (const card of cards) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PANEL_ATTEMPT_TIMEOUT_MS);
      try {
        await deletePanelMessage(env, card.channelId, card.messageId, controller.signal);
        await markLegacyLfgRetired(env.DB, card.id);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.error("Legacy LFG panel retirement failed", card.id, error);
    }
  }
}
