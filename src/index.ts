import { IgdbProvider, GameSelectionService } from "./games";
import { currentListenedGames, matchingLfgCreators, matchingListeners, recordNotificationAction } from "./notifications";
import { InteractionType, ResponseType, json, option, userId, verifyDiscordRequest } from "./discord";
import { canonicalTimeZone, discordTimestamp, effectiveTimeZone, parseWhen } from "./time";
import { dueDeliveries, fireRsvpTrigger } from "./events";
import type { DiscordInteraction, Env, Game } from "./types";

const gameOption = { name: "games", description: "Games", type: 3, required: true, autocomplete: true };
const durationOption = { name: "duration", description: "Duration", type: 3 };
const DELETE_CUSTOM_GAME_PREFIX = "__delete_custom__:";
const commands = [
  { name: "listen", description: "Listen for game alerts", options: [gameOption, durationOption] },
  { name: "unlisten", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "mute", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "lfg", description: "Post a looking-for-group alert", options: [gameOption, durationOption] },
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
    if (request.method === "GET" && new URL(request.url).pathname === "/commands") return json(commands);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response("Invalid request signature", { status: 401 });
    if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
    if (!interaction.guild_id || !interaction.channel_id || !userId(interaction)) return message("Use this command in a server channel.", true);
    const games = new GameSelectionService(env.DB, getIgdbProvider(env));
    if (interaction.type === InteractionType.Autocomplete) return autocomplete(interaction, env, games);
    if (interaction.type === InteractionType.Component) return component(interaction, env, ctx);
    if (interaction.type === InteractionType.ApplicationCommand) return command(interaction, env, games, ctx);
    if (interaction.type === InteractionType.ModalSubmit) return component(interaction, env, ctx);
    return message("Unsupported interaction.", true);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sendScheduledNotifications(env);
  },
} satisfies ExportedHandler<Env>;

async function autocomplete(interaction: DiscordInteraction, env: Env, games: GameSelectionService): Promise<Response> {
  const focused = interaction.data?.options?.find((item) => item.focused);
  const parts = String(focused?.value ?? "").split(",");
  const query = parts.at(-1)?.trim() ?? "";
  const selectedNames = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean);
  const prefix = selectedNames.join(", ");
  const actor = userId(interaction)!;
  const managesListens = interaction.data?.name === "unlisten" || interaction.data?.name === "mute";
  const choices = managesListens
    ? await currentListenedGames(env.DB, interaction.guild_id!, actor, query)
    : await games.search(interaction.guild_id!, query);
  const filtered = choices.filter((game) => !selectedNames.some((name) => name.toLowerCase() === game.name.toLowerCase()));
  if (!managesListens && query && !filtered.some((game) => game.name.toLowerCase() === query.toLowerCase())) {
    filtered.push({ id: "custom", name: `Use "${query}"` });
  }

  const payload: Array<{ name: string; value: string }> = [];
  for (const game of filtered) {
    if (payload.length >= 25) break;
    const customFallback = game.id === "custom";
    const storedCustom = !customFallback && !game.providerId;
    payload.push({
      name: (storedCustom ? `${game.name} · custom` : game.name).slice(0, 100),
      value: prefix
        ? `${prefix}, ${customFallback ? query : game.name}`
        : customFallback ? query : game.name,
    });
    if (payload.length >= 25) break;
    if (storedCustom && (game.createdByUserId === actor || canManageGuild(interaction))) {
      payload.push({
        name: `🗑 Delete ${game.name}`.slice(0, 100),
        value: `${DELETE_CUSTOM_GAME_PREFIX}${game.id}`,
      });
    }
  }
  return json({ type: ResponseType.Autocomplete, data: { choices: payload } });
}

async function command(i: DiscordInteraction, env: Env, games: GameSelectionService, ctx: ExecutionContext): Promise<Response> {
  const name = i.data?.name;
  const actor = userId(i)!;
  try {
    const input = String(option(i, "games") ?? "");
    if (input.startsWith(DELETE_CUSTOM_GAME_PREFIX)) {
      const gameId = input.slice(DELETE_CUSTOM_GAME_PREFIX.length);
      if (!gameId) throw new Error("Invalid custom game deletion.");
      const deleted = await games.deleteCustomGame(i.guild_id!, gameId, actor, canManageGuild(i));
      return message(`Deleted custom game **${deleted.name}**.`, true);
    }
    const selected = name === "unlisten" || name === "mute"
      ? await resolveCurrentListens(env.DB, i.guild_id!, actor, input)
      : await games.resolve(i.guild_id!, input, actor);
    if (name === "listen") return listen(i, env, selected, "listen", actor, ctx);
    if (name === "unlisten" || name === "mute") return listen(i, env, selected, "unlisten", actor, ctx);
    if (name === "lfg") return lfg(i, env, selected, actor);
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

async function resolveCurrentListens(db: D1Database, guildId: string, actor: string, input: string): Promise<Game[]> {
  const requested = [...new Set(input.split(",").map((name) => name.trim()).filter(Boolean))];
  if (!requested.length) throw new Error("Choose one of your current listens.");
  const current = await currentListenedGames(db, guildId, actor);
  return requested.map((name) => {
    const game = current.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!game) throw new Error(`You are not currently listening for ${name}.`);
    return game;
  });
}

async function listen(
  i: DiscordInteraction,
  env: Env,
  games: Game[],
  action: "listen" | "unlisten",
  actor: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const timeZone = userZone.timeZone;
  const duration = parseWhen(String(option(i, "duration") ?? ""), timeZone);
  if (option(i, "duration") && !duration) return message("Use a duration such as 30m, 2h, 3d, tonight, or this weekend.", true);
  const previouslyListening = action === "listen" ? await currentListenedGames(env.DB, i.guild_id!, actor) : [];
  await recordNotificationAction(env.DB, i.guild_id!, actor, games.map((game) => game.id), action, duration);
  if (action === "listen") {
    const newGames = games.filter((game) => !previouslyListening.some((current) => current.id === game.id));
    if (newGames.length) ctx.waitUntil(notifyNewListenMatches(env, i.guild_id!, i.channel_id!, actor, newGames));
  }
  const word = action === "listen" ? "Listening for" : "Not listening for";
  const content = `${word} ${gameNames(games)}${duration ? ` until ${discordTimestamp(duration)}` : ""}.`;
  if (userZone.shouldPrompt) {
    await env.DB.prepare(
      "INSERT INTO users (guild_id, user_id, timezone_prompted_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET timezone_prompted_at = excluded.timezone_prompted_at",
    ).bind(i.guild_id, actor, new Date().toISOString()).run();
    return json({ type: ResponseType.ChannelMessage, data: { content, flags: 64, components: [timezoneComponent()] } });
  }
  return message(content, true);
}

async function notifyNewListenMatches(env: Env, guildId: string, channelId: string, actor: string, games: Game[]): Promise<void> {
  const gameIds = games.map((game) => game.id);
  const [listeners, lfgCreators] = await Promise.all([
    matchingListeners(env.DB, guildId, gameIds, actor),
    matchingLfgCreators(env.DB, guildId, gameIds, actor),
  ]);
  const recipients = [...new Set([...listeners, ...lfgCreators])];
  if (!recipients.length) return;
  const mentions = recipients.map((uid) => `<@${uid}>`).join(" ");
  await postChannelMessage(env, channelId, {
    content: `${mentions} New match: <@${actor}> is now listening for ${gameNames(games)}.`,
    allowed_mentions: { users: recipients },
  });
}

async function lfg(i: DiscordInteraction, env: Env, games: Game[], actor: string): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const timeZone = userZone.timeZone;
  const duration = option(i, "duration") ? parseWhen(String(option(i, "duration")), timeZone) : new Date(Date.now() + 2 * 3_600_000);
  if (!duration) return message("Use a duration such as 30m, 2h, 3d, tonight, or this weekend.", true);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO lfgs (id, guild_id, channel_id, author_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, i.guild_id, i.channel_id, actor, duration.toISOString(), new Date().toISOString()),
    ...games.map((game) => env.DB.prepare("INSERT INTO lfg_games (lfg_id, game_id) VALUES (?, ?)").bind(id, game.id)),
  ]);
  const listeners = await matchingListeners(env.DB, i.guild_id!, games.map((game) => game.id), actor);
  const mentions = listeners.map((uid) => `<@${uid}>`).join(" ");
  const coverUrl = games.find((game) => game.coverUrl)?.coverUrl;
  return json({ type: ResponseType.ChannelMessage, data: {
    content: mentions || undefined,
    embeds: [{
      title: `LFG: ${gameNames(games)}`,
      description: `Available until ${discordTimestamp(duration)}.`,
      thumbnail: coverUrl ? { url: coverUrl } : undefined,
    }],
    allowed_mentions: { users: listeners },
  } });
}

async function createEvent(i: DiscordInteraction, env: Env, games: Game[], actor: string, ctx: ExecutionContext): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const whenInput = String(option(i, "when") ?? "");
  const startsAt = parseWhen(whenInput, userZone.timeZone);
  const trigger = parseTrigger(whenInput);
  if (!startsAt && !trigger) return message("Use a scheduled date/time, or a trigger such as \"3 yes RSVPs\".", true);
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
  const listeners = await matchingListeners(env.DB, i.guild_id!, games.map((game) => game.id), actor);
  const mentions = listeners.map((uid) => `<@${uid}>`).join(" ");
  const data = await eventMessageData(env.DB, id, i.guild_id!);
  return json({ type: ResponseType.ChannelMessage, data: {
    ...data,
    content: mentions || undefined,
    allowed_mentions: { users: listeners },
  } });
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

async function component(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parts = i.data?.custom_id?.split(":") ?? [];
  const action = parts[0];
  if (action === "timezone") {
    const sub = parts[1];
    if (sub === "select") {
      if (!i.guild_id || !userId(i)) return message("Invalid timezone selection context.", true);
      const value = i.data?.values?.[0];
      if (value === "skip" || !value) return message("Timezone unchanged. Using America/New_York by default.", true);
      if (value === "other") {
        return json({ type: ResponseType.Modal, data: {
          custom_id: "timezone:modal",
          title: "Enter your timezone",
          components: [{ type: 1, components: [{ type: 4, custom_id: "tz_value", label: "IANA timezone (e.g. Europe/London)", style: 1, placeholder: "America/New_York", required: true }] }],
        } });
      }
      const selected = canonicalTimeZone(value);
      if (!selected) return message("Invalid timezone selection.", true);
      await env.DB.prepare(
        "INSERT INTO users (guild_id, user_id, timezone, timezone_prompted_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET timezone = excluded.timezone, timezone_prompted_at = excluded.timezone_prompted_at",
      ).bind(i.guild_id, userId(i), selected, new Date().toISOString()).run();
      return message(`Timezone set to ${selected}.`, true);
    }
    if (sub === "other") {
      return json({ type: ResponseType.Modal, data: {
        custom_id: "timezone:modal",
        title: "Enter your timezone",
        components: [{ type: 1, components: [{ type: 4, custom_id: "tz_value", label: "IANA timezone (e.g. Europe/London)", style: 1, placeholder: "America/New_York", required: true }] }],
      } });
    }
    if (sub === "modal") {
      if (!i.guild_id || !userId(i)) return message("Invalid timezone context.", true);
      const raw = (i.data as { components?: Array<{ components?: Array<{ value?: string }> }> })?.components?.[0]?.components?.[0]?.value;
      const selected = canonicalTimeZone(raw);
      if (!selected) return message(`"${raw ?? ""}" is not a valid IANA timezone.`, true);
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

async function userTimeZone(db: D1Database, guildId: string, userIdValue: string): Promise<{ timeZone: string; shouldPrompt: boolean }> {
  const user = await db.prepare("SELECT timezone, timezone_prompted_at FROM users WHERE guild_id = ? AND user_id = ?")
    .bind(guildId, userIdValue).first<{ timezone?: string; timezone_prompted_at?: string }>();
  const shouldPrompt = !user?.timezone && !user?.timezone_prompted_at;
  if (!user) {
    await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").bind(guildId, userIdValue).run();
  }
  return { timeZone: effectiveTimeZone(user?.timezone), shouldPrompt };
}

function timezoneComponent(): unknown {
  return { type: 1, components: [{ type: 3, custom_id: "timezone:select", placeholder: "Optional: set your timezone", min_values: 0, max_values: 1, options: timezoneOptions }] };
}

function parseTrigger(value: string): { type: string; threshold: number } | undefined {
  const match = /^(\d+)\s+(people online|listeners online|yes rsvps|yes-or-maybe rsvps)$/i.exec(value.trim());
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
  const response = await postChannelMessage(env, channelId, { content });
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
