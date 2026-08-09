import { collectDeletedCustomGames, IgdbProvider, GameSelectionService } from "./games";
import {
  activeUsersByGame,
  createLfg,
  expiredUnfinalizedLfgs,
  lfgSnapshot,
  lfgState,
  markLfgFinalized,
  mutateLfg,
  refreshableLfgsForGames,
  saveLfgMessageId,
  type LfgSnapshot,
} from "./lfg";
import { InteractionType, ResponseType, json, option, userId, verifyDiscordRequest } from "./discord";
import { canonicalTimeZone, discordTimestamp, effectiveTimeZone, parseWhen } from "./time";
import { dueDeliveries, fireRsvpTrigger } from "./events";
import type { DiscordInteraction, Env, Game } from "./types";

const gameOption = { name: "games", description: "Games", type: 3, required: true, autocomplete: true };
const durationOption = { name: "duration", description: "Duration", type: 3 };
const commands = [
  { name: "lfg", description: "Look for people to play with", options: [gameOption, durationOption] },
  { name: "create", description: "Create a game event", options: [gameOption, { name: "when", description: "When", type: 3, required: true }] },
];

let cachedIgdb: { clientId?: string; clientSecret?: string; provider: IgdbProvider } | undefined;
function getIgdbProvider(env: Env): IgdbProvider {
  if (!cachedIgdb || cachedIgdb.clientId !== env.IGDB_CLIENT_ID || cachedIgdb.clientSecret !== env.IGDB_CLIENT_SECRET) {
    cachedIgdb = { clientId: env.IGDB_CLIENT_ID, clientSecret: env.IGDB_CLIENT_SECRET, provider: new IgdbProvider(env.IGDB_CLIENT_ID, env.IGDB_CLIENT_SECRET) };
  }
  return cachedIgdb.provider;
}

const timezoneOptions = [
  { label: "Eastern (New York)", value: "America/New_York" },
  { label: "Central (Chicago)", value: "America/Chicago" },
  { label: "Mountain (Denver)", value: "America/Denver" },
  { label: "Pacific (Los Angeles)", value: "America/Los_Angeles" },
  { label: "Skip (keep America/New_York)", value: "skip" },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/commands") return json(commands);
    if (request.method === "GET" && url.pathname === "/register-commands") return registerCommands(env);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response("Invalid request signature", { status: 401 });
    if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
    if (!interaction.guild_id || !interaction.channel_id || !userId(interaction)) return message("Use this command in a server channel.", true);
    const games = new GameSelectionService(env.DB, getIgdbProvider(env));
    if (interaction.type === InteractionType.Autocomplete) return autocomplete(interaction, games);
    if (interaction.type === InteractionType.Component) return component(interaction, env, ctx);
    if (interaction.type === InteractionType.ApplicationCommand) return command(interaction, env, games, ctx);
    if (interaction.type === InteractionType.ModalSubmit) return component(interaction, env, ctx);
    return message("Unsupported interaction.", true);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sendScheduledNotifications(env);
    await finalizeExpiredLfgs(env);
    await collectDeletedCustomGames(env.DB);
  },
} satisfies ExportedHandler<Env>;

async function registerCommands(env: Env): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN) return new Response("DISCORD_BOT_TOKEN is not configured.", { status: 500 });
  const headers = { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" };
  const appResponse = await fetch("https://discord.com/api/v10/oauth2/applications/@me", { headers });
  if (!appResponse.ok) return new Response(`Could not identify Discord application (${appResponse.status}).`, { status: 502 });
  const application = await appResponse.json() as { id: string };
  const response = await fetch(`https://discord.com/api/v10/applications/${application.id}/commands`, {
    method: "PUT",
    headers,
    body: JSON.stringify(commands),
  });
  if (!response.ok) return new Response(`Discord registration failed (${response.status}).`, { status: 502 });
  return new Response("Registered /lfg and /create. This temporary endpoint can now be removed.");
}

async function autocomplete(interaction: DiscordInteraction, games: GameSelectionService): Promise<Response> {
  const focused = interaction.data?.options?.find((item) => item.focused);
  const parts = String(focused?.value ?? "").split(",");
  const query = parts.at(-1)?.trim() ?? "";
  const selectedNames = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean);
  const prefix = selectedNames.join(", ");
  const choices = await games.search(interaction.guild_id!, query);
  const filtered = choices.filter((game) => !selectedNames.some((name) => name.toLowerCase() === game.name.toLowerCase()));
  if (query && !filtered.some((game) => game.name.toLowerCase() === query.toLowerCase())) {
    filtered.push({ id: "custom", name: `Use "${query}"` });
  }
  return json({ type: ResponseType.Autocomplete, data: { choices: filtered.slice(0, 25).map((game) => {
    const customFallback = game.id === "custom";
    const suffix = !customFallback && !game.providerId ? " · custom" : "";
    return {
      name: `${game.name}${suffix}`.slice(0, 100),
      value: prefix
        ? `${prefix}, ${customFallback ? query : game.name}`
        : customFallback ? query : game.name,
    };
  }) } });
}

async function command(i: DiscordInteraction, env: Env, games: GameSelectionService, ctx: ExecutionContext): Promise<Response> {
  const name = i.data?.name;
  const actor = userId(i)!;
  try {
    const selected = await games.resolve(i.guild_id!, String(option(i, "games") ?? ""), actor);
    if (name === "lfg") return lfg(i, env, selected, actor, ctx);
    if (name === "create") return createEvent(i, env, selected, actor, ctx);
  } catch (error) {
    return message(error instanceof Error ? error.message : "Could not complete that command.", true);
  }
  return message("Unknown command.", true);
}

function canManageGuild(i: DiscordInteraction): boolean {
  try {
    const permissions = BigInt(i.member?.permissions ?? "0");
    return (permissions & 8n) !== 0n || (permissions & 32n) !== 0n;
  } catch {
    return false;
  }
}

async function lfg(i: DiscordInteraction, env: Env, games: Game[], actor: string, ctx: ExecutionContext): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const duration = option(i, "duration")
    ? parseWhen(String(option(i, "duration")), userZone.timeZone)
    : new Date(Date.now() + 2 * 3_600_000);
  if (!duration) return message("Use a duration such as 30m, 2h, 3d, tonight, or this weekend.", true);
  if (userZone.shouldPrompt) await markTimezonePrompted(env.DB, i.guild_id!, actor);

  const created = await createLfg(env.DB, i.guild_id!, i.channel_id!, actor, games, duration);
  const snapshot = await lfgSnapshot(env.DB, i.guild_id!, created.id);
  if (!snapshot) throw new Error("Could not create this LFG.");
  ctx.waitUntil(afterLfgCreated(env, i, snapshot, created.newlyOverlappingGameIds, created.recipients, userZone.shouldPrompt));
  return json({ type: ResponseType.ChannelMessage, data: lfgMessageData(snapshot) });
}

function lfgMessageData(snapshot: LfgSnapshot, loadingAction?: "pause" | "resume" | "stop"): Record<string, unknown> {
  const state = lfgState(snapshot.lfg);
  const coverUrl = snapshot.games.find((game) => game.coverUrl)?.coverUrl;
  const status = loadingAction
    ? `${loadingAction === "pause" ? "Pausing" : loadingAction === "resume" ? "Resuming" : "Stopping"}…`
    : state === "active" ? "Looking"
      : state === "paused" ? "Paused"
        : state === "stopped" ? "Stopped"
          : "Expired";
  const primaryControl = state === "paused"
    ? { type: 2, style: 1, label: "▶ Resume", custom_id: `lfg:resume:${snapshot.lfg.id}` }
    : { type: 2, style: 1, label: "⏸ Pause", custom_id: `lfg:pause:${snapshot.lfg.id}` };
  const components = state === "stopped" || state === "expired"
    ? []
    : [{
      type: 1,
      components: loadingAction === "stop"
        ? [
          { ...primaryControl, disabled: true },
          { type: 2, style: 4, label: "⏳ Stopping…", custom_id: `lfg:busy:${snapshot.lfg.id}`, disabled: true },
        ]
        : loadingAction
          ? [
            { type: 2, style: 1, label: `⏳ ${status}`, custom_id: `lfg:busy:${snapshot.lfg.id}`, disabled: true },
            { type: 2, style: 4, label: "■ Stop", custom_id: `lfg:stop:${snapshot.lfg.id}`, disabled: true },
          ]
          : [
            primaryControl,
            { type: 2, style: 4, label: "■ Stop", custom_id: `lfg:stop:${snapshot.lfg.id}` },
          ],
    }];
  return {
    embeds: [{
      title: `LFG: ${gameNames(snapshot.games)}`,
      description: `${status} · until ${discordTimestamp(new Date(snapshot.lfg.expiresAt))}`,
      fields: snapshot.games.slice(0, 25).map((game) => ({
        name: game.name,
        value: `${snapshot.counts.get(game.id) ?? 0} available`,
        inline: true,
      })),
      thumbnail: coverUrl ? { url: coverUrl } : undefined,
    }],
    components,
  };
}

async function afterLfgCreated(
  env: Env,
  i: DiscordInteraction,
  snapshot: LfgSnapshot,
  newlyOverlappingGameIds: string[],
  recipients: string[],
  shouldPromptTimezone: boolean,
): Promise<void> {
  await captureOriginalLfgMessage(env.DB, i, snapshot.lfg.id);
  const gameIds = snapshot.games.map((game) => game.id);
  await refreshLfgCardsForGames(env, snapshot.lfg.guildId, gameIds);
  await notifyLfgOverlap(
    env,
    snapshot.lfg.guildId,
    snapshot.lfg.channelId,
    snapshot.lfg.authorId,
    snapshot.games,
    newlyOverlappingGameIds,
    recipients,
  );
  await sendPostCommandControls(i, snapshot.games, shouldPromptTimezone);
}

async function captureOriginalLfgMessage(db: D1Database, i: DiscordInteraction, lfgId: string): Promise<void> {
  if (!i.application_id) return;
  const waits = [0, 100, 250, 500];
  for (const wait of waits) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`);
    if (!response.ok) continue;
    const body = await response.json() as { id?: string };
    if (body.id) {
      await saveLfgMessageId(db, lfgId, body.id);
      return;
    }
  }
  console.warn("Could not capture LFG Discord message id", lfgId);
}

async function notifyLfgOverlap(
  env: Env,
  guildId: string,
  channelId: string,
  actor: string,
  games: Game[],
  gameIds: string[],
  recipients: string[],
): Promise<void> {
  if (!gameIds.length || !recipients.length) return;
  const selected = games.filter((game) => gameIds.includes(game.id));
  const active = await activeUsersByGame(env.DB, guildId, gameIds);
  const mentions = recipients.map((uid) => `<@${uid}>`).join(" ");
  const counts = selected.map((game) => `**${game.name}** — ${active.get(game.id)?.length ?? 0} available`).join("\n");
  await postChannelMessage(env, channelId, {
    content: `${mentions} New overlap with <@${actor}>:\n${counts}`,
    allowed_mentions: { users: recipients },
  });
}

async function refreshLfgCardsForGames(env: Env, guildId: string, gameIds: string[], exceptMessageId?: string): Promise<void> {
  const records = await refreshableLfgsForGames(env.DB, guildId, gameIds);
  for (const record of records) {
    if (!record.discordMessageId || record.discordMessageId === exceptMessageId) continue;
    const snapshot = await lfgSnapshot(env.DB, guildId, record.id);
    if (!snapshot) continue;
    await editChannelMessage(env, record.channelId, record.discordMessageId, lfgMessageData(snapshot));
  }
}

async function completeLfgAction(
  env: Env,
  i: DiscordInteraction,
  lfgId: string,
  action: "pause" | "resume" | "stop",
): Promise<void> {
  const actor = userId(i)!;
  const messageId = i.message?.id;
  try {
    if (messageId) await saveLfgMessageId(env.DB, lfgId, messageId);
    const result = await mutateLfg(env.DB, i.guild_id!, lfgId, actor, action);
    const currentMessageId = messageId ?? result.snapshot.lfg.discordMessageId;
    let edited = true;
    if (currentMessageId) {
      edited = await editChannelMessage(env, result.snapshot.lfg.channelId, currentMessageId, lfgMessageData(result.snapshot));
      if (!edited) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        edited = await editChannelMessage(env, result.snapshot.lfg.channelId, currentMessageId, lfgMessageData(result.snapshot));
      }
    }
    await refreshLfgCardsForGames(env, result.snapshot.lfg.guildId, result.changedGameIds, currentMessageId);
    if (action === "resume") {
      await notifyLfgOverlap(
        env,
        result.snapshot.lfg.guildId,
        result.snapshot.lfg.channelId,
        actor,
        result.snapshot.games,
        result.newlyOverlappingGameIds,
        result.recipients,
      );
    }
    if (action === "stop") await collectDeletedCustomGames(env.DB);
    if (!edited) await interactionFollowup(i, "The LFG state changed, but Discord did not refresh the card. Try again in a moment.");
  } catch (error) {
    const latest = await lfgSnapshot(env.DB, i.guild_id!, lfgId);
    if (latest && messageId) await editChannelMessage(env, latest.lfg.channelId, messageId, lfgMessageData(latest));
    await interactionFollowup(i, error instanceof Error ? error.message : "Could not update this LFG.");
  }
}

async function finalizeExpiredLfgs(env: Env): Promise<void> {
  const expired = await expiredUnfinalizedLfgs(env.DB);
  for (const item of expired) {
    const snapshot = await lfgSnapshot(env.DB, item.lfg.guildId, item.lfg.id);
    let ownCardUpdated = true;
    if (snapshot && item.lfg.discordMessageId) {
      ownCardUpdated = await editChannelMessage(env, item.lfg.channelId, item.lfg.discordMessageId, lfgMessageData(snapshot));
    }
    await refreshLfgCardsForGames(env, item.lfg.guildId, item.gameIds, item.lfg.discordMessageId);
    if (ownCardUpdated || !item.lfg.discordMessageId) await markLfgFinalized(env.DB, item.lfg.id);
  }
}

async function editChannelMessage(env: Env, channelId: string, messageId: string, body: Record<string, unknown>): Promise<boolean> {
  if (!env.DISCORD_BOT_TOKEN) return false;
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) console.error("Discord message edit failed", response.status, await response.text());
  return response.ok;
}

async function interactionFollowup(i: DiscordInteraction, content: string): Promise<void> {
  if (!i.application_id) return;
  const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, flags: 64 }),
  });
  if (!response.ok) console.error("Discord interaction followup failed", response.status, await response.text());
}

async function createEvent(i: DiscordInteraction, env: Env, games: Game[], actor: string, ctx: ExecutionContext): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const whenInput = String(option(i, "when") ?? "");
  const startsAt = parseWhen(whenInput, userZone.timeZone);
  const trigger = parseTrigger(whenInput);
  if (!startsAt && !trigger) return message("Use a scheduled date/time, or a trigger such as \"3 yes RSVPs\".", true);
  if (userZone.shouldPrompt) await markTimezonePrompted(env.DB, i.guild_id!, actor);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (id, guild_id, channel_id, author_id, title, starts_at, when_input) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, i.guild_id, i.channel_id, actor, "Game night", startsAt?.toISOString() ?? null, whenInput),
    ...games.map((game) => env.DB.prepare("INSERT INTO event_games (event_id, game_id) VALUES (?, ?)").bind(id, game.id)),
    env.DB.prepare("INSERT INTO rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, 'yes', ?)").bind(id, actor, now),
    ...(trigger ? [env.DB.prepare("INSERT INTO event_triggers (event_id, type, threshold) VALUES (?, ?, ?)").bind(id, trigger.type, trigger.threshold)] : []),
  ]);
  if (trigger && await fireRsvpTrigger(env.DB, id)) ctx.waitUntil(notifyActivation(env, id));
  const data = await eventMessageData(env.DB, id, i.guild_id!);
  ctx.waitUntil(sendPostCommandControls(i, games, userZone.shouldPrompt));
  return json({ type: ResponseType.ChannelMessage, data });
}

async function eventMessageData(db: D1Database, eventId: string, guildId: string): Promise<Record<string, unknown>> {
  const event = await db.prepare("SELECT id, title, starts_at, when_input FROM events WHERE id = ? AND guild_id = ?")
    .bind(eventId, guildId).first<{ id: string; title: string; starts_at?: string; when_input?: string }>();
  if (!event) throw new Error("Event not found.");
  const games = await db.prepare(`
    SELECT games.id, games.name, games.provider_id AS providerId, games.cover_url AS coverUrl
    FROM event_games JOIN games ON games.id = event_games.game_id
    WHERE event_games.event_id = ? ORDER BY games.name
  `).bind(eventId).all<Game>();
  const rsvps = await db.prepare("SELECT user_id, status FROM rsvps WHERE event_id = ? ORDER BY updated_at")
    .bind(eventId).all<{ user_id: string; status: "yes" | "maybe" | "no" }>();
  const trigger = await db.prepare("SELECT type, threshold FROM event_triggers WHERE event_id = ?")
    .bind(eventId).first<{ type: string; threshold: number }>();
  const byStatus = (status: "yes" | "maybe" | "no") => {
    const users = rsvps.results.filter((rsvp) => rsvp.status === status).map((rsvp) => `<@${rsvp.user_id}>`);
    return users.length ? users.join(" ") : "—";
  };
  const when = event.starts_at
    ? discordTimestamp(new Date(event.starts_at))
    : trigger ? `${trigger.threshold} ${trigger.type.replaceAll("_", " ")}` : event.when_input ?? "—";
  const coverUrl = games.results.find((game) => game.coverUrl)?.coverUrl;
  return {
    embeds: [{
      title: event.title,
      fields: [
        { name: "Games", value: gameNames(games.results), inline: false },
        { name: "When", value: when, inline: false },
        { name: `Yes (${rsvps.results.filter((rsvp) => rsvp.status === "yes").length})`, value: byStatus("yes"), inline: false },
        { name: `Maybe (${rsvps.results.filter((rsvp) => rsvp.status === "maybe").length})`, value: byStatus("maybe"), inline: false },
        { name: `No (${rsvps.results.filter((rsvp) => rsvp.status === "no").length})`, value: byStatus("no"), inline: false },
      ],
      thumbnail: coverUrl ? { url: coverUrl } : undefined,
    }],
    components: eventComponents(eventId, games.results),
  };
}

function eventComponents(eventId: string, games: Game[]): unknown[] {
  const components: unknown[] = [{
    type: 1,
    components: [["yes", 3], ["maybe", 2], ["no", 4]].map(([status, style]) => ({
      type: 2,
      style,
      label: String(status).replace(/^./, (letter) => letter.toUpperCase()),
      custom_id: `rsvp:${eventId}:${status}`,
    })),
  }];
  if (games.length > 1) components.push({
    type: 1,
    components: [{
      type: 3,
      custom_id: `vote:${eventId}`,
      placeholder: "Vote for games",
      min_values: 1,
      max_values: games.length,
      options: games.map((game) => ({ label: game.name, value: game.id })),
    }],
  });
  return components;
}

function timezoneComponent(): unknown {
  return { type: 1, components: [{ type: 3, custom_id: "timezone:select", placeholder: "Optional: set your timezone", min_values: 1, max_values: 1, options: timezoneOptions }] };
}

function customGameDeleteComponents(i: DiscordInteraction, games: Game[], maxRows = 5): unknown[] {
  const actor = userId(i);
  if (!actor) return [];
  const canManage = canManageGuild(i);
  const deletable = games.filter((game) => !game.providerId && !game.deletedAt && (game.createdByUserId === actor || canManage));
  const rows: unknown[] = [];
  for (let index = 0; index < deletable.length && rows.length < maxRows; index += 5) {
    rows.push({
      type: 1,
      components: deletable.slice(index, index + 5).map((game) => ({
        type: 2,
        style: 4,
        label: `Delete ${game.name}`.slice(0, 80),
        custom_id: `custom-game-delete:${game.id}`,
      })),
    });
  }
  return rows;
}

async function sendPostCommandControls(i: DiscordInteraction, games: Game[], shouldPromptTimezone: boolean): Promise<void> {
  if (!i.application_id) return;
  const components = [
    ...(shouldPromptTimezone ? [timezoneComponent()] : []),
    ...customGameDeleteComponents(i, games, shouldPromptTimezone ? 4 : 5),
  ];
  if (!components.length) return;
  const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: shouldPromptTimezone ? "Optional settings" : "Custom games", flags: 64, components }),
  });
  if (!response.ok) console.error("Discord post-command controls failed", response.status, await response.text());
}

async function component(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parts = i.data?.custom_id?.split(":") ?? [];
  const action = parts[0];

  if (action === "lfg") {
    const requested = parts[1] as "pause" | "resume" | "stop" | "busy" | undefined;
    const lfgId = parts[2];
    if (!lfgId || !requested || requested === "busy" || !i.guild_id || !userId(i)) return message("This LFG action is not available.", true);
    const snapshot = await lfgSnapshot(env.DB, i.guild_id, lfgId);
    if (!snapshot) return message("That LFG no longer exists.", true);
    if (snapshot.lfg.authorId !== userId(i)) return message("Only the person who created this LFG can change it.", true);
    const state = lfgState(snapshot.lfg);
    if (state === "expired" || state === "stopped") return message("This LFG has already ended.", true);
    if (requested === "pause" && state !== "active") return message("This LFG is not active.", true);
    if (requested === "resume" && state !== "paused") return message("This LFG is not paused.", true);
    ctx.waitUntil(completeLfgAction(env, i, lfgId, requested));
    return json({ type: ResponseType.UpdateMessage, data: lfgMessageData(snapshot, requested) });
  }

  if (action === "custom-game-delete") {
    const gameId = parts[1];
    if (!gameId || !i.guild_id || !userId(i)) return message("Invalid custom game deletion.", true);
    try {
      const games = new GameSelectionService(env.DB, getIgdbProvider(env));
      const result = await games.deleteCustomGame(i.guild_id, gameId, userId(i)!, canManageGuild(i));
      return message(
        result.collected
          ? `Deleted custom game **${result.game.name}**.`
          : `Removed **${result.game.name}** from future selections. Existing LFGs and events will keep working until they finish.`,
        true,
      );
    } catch (error) {
      return message(error instanceof Error ? error.message : "Could not delete that custom game.", true);
    }
  }

  if (action === "timezone") {
    const sub = parts[1];
    if (sub === "select") {
      if (!i.guild_id || !userId(i)) return message("Invalid timezone selection context.", true);
      const value = i.data?.values?.[0];
      if (value === "skip" || !value) return message("Timezone unchanged. Using America/New_York by default.", true);
      const selected = canonicalTimeZone(value);
      if (!selected) return message("Invalid timezone selection.", true);
      await env.DB.prepare(
        "INSERT INTO users (guild_id, user_id, timezone, timezone_prompted_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET timezone = excluded.timezone, timezone_prompted_at = excluded.timezone_prompted_at",
      ).bind(i.guild_id, userId(i), selected, new Date().toISOString()).run();
      return message(`Timezone set to ${selected}.`, true);
    }
    return message("Invalid timezone action.", true);
  }

  const [, eventId, status] = parts;
  if (!eventId) return message("Invalid event action.", true);
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND guild_id = ?").bind(eventId, i.guild_id).first();
  if (!event) return message("This event is not available in this server.", true);
  if ((action === "rsvp" || action === "vote") && !await eventAcceptsChanges(env.DB, eventId)) {
    return message("This event is no longer accepting changes.", true);
  }
  if (action === "rsvp" && ["yes", "maybe", "no"].includes(status ?? "")) {
    await env.DB.prepare("INSERT INTO rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at")
      .bind(eventId, userId(i), status, new Date().toISOString()).run();
    if (await fireRsvpTrigger(env.DB, eventId)) ctx.waitUntil(notifyActivation(env, eventId));
    return json({ type: ResponseType.UpdateMessage, data: await eventMessageData(env.DB, eventId, i.guild_id!) });
  }
  if (action === "vote") {
    const values = i.data?.values ?? [];
    const valid = await env.DB.prepare(`SELECT game_id FROM event_games WHERE event_id = ? AND game_id IN (${values.map(() => "?").join(",") || "NULL"})`).bind(eventId, ...values).all<{ game_id: string }>();
    if (valid.results.length !== values.length) return message("Invalid game selection.", true);
    await env.DB.batch([env.DB.prepare("DELETE FROM event_game_votes WHERE event_id = ? AND user_id = ?").bind(eventId, userId(i)), ...values.map((gameId) => env.DB.prepare("INSERT INTO event_game_votes (event_id, user_id, game_id) VALUES (?, ?, ?)").bind(eventId, userId(i), gameId))]);
    return message("Game vote recorded.", true);
  }
  return message("Invalid event action.", true);
}

async function eventAcceptsChanges(db: D1Database, eventId: string): Promise<boolean> {
  const event = await db.prepare(`
    SELECT events.starts_at, event_triggers.fired_at
    FROM events LEFT JOIN event_triggers ON event_triggers.event_id = events.id
    WHERE events.id = ?
  `).bind(eventId).first<{ starts_at?: string; fired_at?: string }>();
  if (!event) return false;
  if (event.starts_at) return new Date(event.starts_at).getTime() > Date.now();
  return !event.fired_at;
}

async function userTimeZone(db: D1Database, guildId: string, userIdValue: string): Promise<{ timeZone: string; shouldPrompt: boolean }> {
  const user = await db.prepare("SELECT timezone, timezone_prompted_at FROM users WHERE guild_id = ? AND user_id = ?")
    .bind(guildId, userIdValue).first<{ timezone?: string; timezone_prompted_at?: string }>();
  const shouldPrompt = !user?.timezone && !user?.timezone_prompted_at;
  if (!user) await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").bind(guildId, userIdValue).run();
  return { timeZone: effectiveTimeZone(user?.timezone), shouldPrompt };
}

async function markTimezonePrompted(db: D1Database, guildId: string, userIdValue: string): Promise<void> {
  await db.prepare(
    "INSERT INTO users (guild_id, user_id, timezone_prompted_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET timezone_prompted_at = excluded.timezone_prompted_at",
  ).bind(guildId, userIdValue, new Date().toISOString()).run();
}

function parseTrigger(value: string): { type: string; threshold: number } | undefined {
  const match = /^(\d+)\s+(people online|yes rsvps|yes-or-maybe rsvps)$/i.exec(value.trim());
  return match ? { threshold: Number(match[1]), type: match[2].toLowerCase().replaceAll(" ", "_") } : undefined;
}

async function sendScheduledNotifications(env: Env, now = new Date()): Promise<void> {
  const events = await env.DB.prepare(`
    SELECT events.id, events.channel_id, events.title, events.starts_at, rsvps.user_id, rsvps.status
    FROM events JOIN rsvps ON rsvps.event_id = events.id
    WHERE events.starts_at IS NOT NULL AND events.starts_at <= ?
  `).bind(new Date(now.getTime() + 3_600_000).toISOString()).all<{
    id: string; channel_id: string; title: string; starts_at: string; user_id: string; status: "yes" | "maybe" | "no";
  }>();
  for (const event of events.results) {
    for (const kind of dueDeliveries(new Date(event.starts_at), event.status, now)) {
      const content = kind === "reminder"
        ? `<@${event.user_id}> Reminder: **${event.title}** starts in about an hour.`
        : `<@${event.user_id}> **${event.title}** is starting now.`;
      await deliver(env, event.id, event.user_id, kind, event.channel_id, content);
    }
  }
}

async function notifyActivation(env: Env, eventId: string): Promise<void> {
  const event = await env.DB.prepare("SELECT channel_id, title FROM events WHERE id = ?").bind(eventId)
    .first<{ channel_id: string; title: string }>();
  if (event) await deliver(env, eventId, "", "activation", event.channel_id, `**${event.title}** is now active.`);
}

async function deliver(env: Env, eventId: string, userIdValue: string, kind: "reminder" | "start" | "activation", channelId: string, content: string): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) return;
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO event_deliveries (event_id, user_id, kind, delivered_at) VALUES (?, ?, ?, ?)")
    .bind(eventId, userIdValue, kind, new Date().toISOString()).run();
  if (!claimed.meta.changes) return;
  const response = await postChannelMessage(env, channelId, {
    content,
    allowed_mentions: userIdValue ? { users: [userIdValue] } : { parse: [] },
  });
  if (!response?.ok) await env.DB.prepare("DELETE FROM event_deliveries WHERE event_id = ? AND user_id = ? AND kind = ?")
    .bind(eventId, userIdValue, kind).run();
}

async function postChannelMessage(env: Env, channelId: string, body: Record<string, unknown>): Promise<Response | undefined> {
  if (!env.DISCORD_BOT_TOKEN) return undefined;
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) console.error("Discord channel message failed", response.status, await response.text());
  return response;
}

function message(content: string, ephemeral: boolean): Response {
  return json({ type: ResponseType.ChannelMessage, data: { content, flags: ephemeral ? 64 : undefined } });
}

function gameNames(games: Game[]): string { return games.map((game) => game.name).join(", "); }
