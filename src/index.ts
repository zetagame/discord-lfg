import { IgdbProvider, GameSelectionService } from "./games";
import { matchingListeners, recordNotificationAction } from "./notifications";
import { InteractionType, ResponseType, json, option, userId, verifyDiscordRequest } from "./discord";
import { canonicalTimeZone, effectiveTimeZone, parseWhen } from "./time";
import { dueDeliveries, fireRsvpTrigger } from "./events";
import type { DiscordInteraction, Env, Game } from "./types";

const gameOption = { name: "games", description: "Games", type: 3, required: true, autocomplete: true };
const durationOption = { name: "duration", description: "Duration", type: 3 };
const commands = [
  { name: "listen", description: "Listen for game alerts", options: [gameOption, durationOption] },
  { name: "unlisten", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "mute", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "lfg", description: "Post a looking-for-group alert", options: [gameOption, durationOption] },
  { name: "create", description: "Create a game event", options: [gameOption, { name: "when", description: "When", type: 3, required: true }] },
];
const timezoneOptions = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/commands") return json(commands);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response("Invalid request signature", { status: 401 });
    if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
    if (!interaction.guild_id || !interaction.channel_id || !userId(interaction)) return message("Use this command in a server channel.", true);
    const games = new GameSelectionService(env.DB, new IgdbProvider(env.IGDB_CLIENT_ID, env.IGDB_CLIENT_SECRET));
    if (interaction.type === InteractionType.Autocomplete) return autocomplete(interaction, games);
    if (interaction.type === InteractionType.Component) return component(interaction, env);
    if (interaction.type === InteractionType.ApplicationCommand) return command(interaction, env, games);
    return message("Unsupported interaction.", true);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sendScheduledNotifications(env);
  },
} satisfies ExportedHandler<Env>;

async function autocomplete(interaction: DiscordInteraction, games: GameSelectionService): Promise<Response> {
  const focused = interaction.data?.options?.find((item) => item.focused);
  const parts = String(focused?.value ?? "").split(",");
  const query = parts.at(-1)?.trim() ?? "";
  const prefix = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean).join(", ");
  const choices = await games.search(interaction.guild_id!, query);
  if (query && !choices.some((game) => game.name.toLowerCase() === query.toLowerCase())) choices.push({ id: "custom", name: `Use "${query}"` });
  return json({ type: ResponseType.Autocomplete, data: { choices: choices.slice(0, 25).map((game) => ({
    name: game.id === "custom" ? game.name : game.name, value: prefix ? `${prefix}, ${game.id === "custom" ? query : game.name}` : game.id === "custom" ? query : game.name,
  })) } });
}

async function command(i: DiscordInteraction, env: Env, games: GameSelectionService): Promise<Response> {
  const name = i.data?.name;
  const actor = userId(i)!;
  try {
    const selected = await games.resolve(i.guild_id!, String(option(i, "games") ?? ""));
    if (name === "listen") return listen(i, env, selected, "listen", actor);
    if (name === "unlisten" || name === "mute") return listen(i, env, selected, "unlisten", actor);
    if (name === "lfg") return lfg(i, env, selected, actor);
    if (name === "create") return createEvent(i, env, selected, actor);
  } catch (error) {
    return message(error instanceof Error ? error.message : "Could not complete that command.", true);
  }
  return message("Unknown command.", true);
}

async function listen(i: DiscordInteraction, env: Env, games: Game[], action: "listen" | "unlisten", actor: string): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const timeZone = userZone.timeZone;
  const duration = parseWhen(String(option(i, "duration") ?? ""), timeZone);
  if (option(i, "duration") && !duration) return message("Use a duration such as 30m, 2h, 3d, tonight, or this weekend.", true);
  await recordNotificationAction(env.DB, i.guild_id!, actor, games.map((game) => game.id), action, duration);
  if (userZone.shouldPrompt) await maybeSendTimezonePrompt(i, env);
  const word = action === "listen" ? "Listening for" : "Not listening for";
  return message(`${word} ${gameNames(games)}${duration ? ` until ${duration.toISOString()}` : ""}.`, true);
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
  if (userZone.shouldPrompt) await maybeSendTimezonePrompt(i, env);
  return publicEmbed("LFG", `${gameNames(games)}\nRelevant until ${duration.toISOString()}${listeners.length ? `\n${listeners.map((id) => `<@${id}>`).join(" ")}` : ""}`);
}

async function createEvent(i: DiscordInteraction, env: Env, games: Game[], actor: string): Promise<Response> {
  const userZone = await userTimeZone(env.DB, i.guild_id!, actor);
  const whenInput = String(option(i, "when") ?? "");
  const startsAt = parseWhen(whenInput, userZone.timeZone);
  const trigger = parseTrigger(whenInput);
  if (!startsAt && !trigger) return message("Use a scheduled date/time, or a trigger such as \"3 yes RSVPs\".", true);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (id, guild_id, channel_id, author_id, title, game_ids, starts_at, when_input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, i.guild_id, i.channel_id, actor, "Game night", JSON.stringify(games.map((game) => game.id)), startsAt?.toISOString() ?? null, whenInput),
    ...games.map((game) => env.DB.prepare("INSERT INTO event_games (event_id, game_id) VALUES (?, ?)").bind(id, game.id)),
    ...(trigger ? [env.DB.prepare("INSERT INTO event_triggers (event_id, type, threshold) VALUES (?, ?, ?)").bind(id, trigger.type, trigger.threshold)] : []),
  ]);
  const components: unknown[] = [{ type: 1, components: [["yes", 3], ["maybe", 2], ["no", 4]].map(([status, style]) => ({ type: 2, style, label: String(status).replace(/^./, (letter) => letter.toUpperCase()), custom_id: `rsvp:${id}:${status}` })) }];
  if (games.length > 1) components.push({ type: 1, components: [{ type: 3, custom_id: `vote:${id}`, placeholder: "Vote for games", min_values: 1, max_values: games.length, options: games.map((game) => ({ label: game.name, value: game.id })) }] });
  if (userZone.shouldPrompt) await maybeSendTimezonePrompt(i, env);
  return json({ type: ResponseType.ChannelMessage, data: { embeds: [{ title: "Game night", description: `Games: ${gameNames(games)}\n${trigger ? `Trigger: ${whenInput}` : `When: ${startsAt!.toISOString()} (${userZone.timeZone})`}` }], components } });
}

async function component(i: DiscordInteraction, env: Env): Promise<Response> {
  const [action, eventId, status] = i.data?.custom_id?.split(":") ?? [];
  if (action === "timezone" && status === "select") {
    if (!i.guild_id || !userId(i)) return message("Invalid timezone selection context.", true);
    const selected = canonicalTimeZone(i.data?.values?.[0]);
    if (!selected) return message("Invalid timezone selection.", true);
    await env.DB.prepare("UPDATE users SET timezone = ?, timezone_prompted_at = ? WHERE guild_id = ? AND user_id = ?")
      .bind(selected, new Date().toISOString(), i.guild_id, userId(i)).run();
    return message(`Timezone set to ${selected}.`, true);
  }
  if (!eventId) return message("Invalid event action.", true);
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND guild_id = ?").bind(eventId, i.guild_id).first();
  if (!event) return message("This event is not available in this server.", true);
  if (action === "rsvp" && ["yes", "maybe", "no"].includes(status ?? "")) {
    await env.DB.prepare("INSERT INTO rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at")
      .bind(eventId, userId(i), status, new Date().toISOString()).run();
    if (await fireRsvpTrigger(env.DB, eventId)) await notifyActivation(env, eventId);
    return message(`RSVP updated to ${status}.`, true);
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

async function userTimeZone(db: D1Database, guildId: string, userId: string): Promise<{ timeZone: string; shouldPrompt: boolean }> {
  const user = await db.prepare("SELECT timezone, timezone_prompted_at FROM users WHERE guild_id = ? AND user_id = ?")
    .bind(guildId, userId).first<{ timezone?: string; timezone_prompted_at?: string }>();
  const shouldPrompt = !user?.timezone && !user?.timezone_prompted_at;
  if (!user) {
    await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id, timezone_prompted_at) VALUES (?, ?, ?)")
      .bind(guildId, userId, shouldPrompt ? new Date().toISOString() : null).run();
  } else if (shouldPrompt) {
    await db.prepare("UPDATE users SET timezone_prompted_at = ? WHERE guild_id = ? AND user_id = ?")
      .bind(new Date().toISOString(), guildId, userId).run();
  }
  return { timeZone: effectiveTimeZone(user?.timezone), shouldPrompt };
}

async function maybeSendTimezonePrompt(i: DiscordInteraction, env: Env): Promise<void> {
  if (!i.application_id) return;
  await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flags: 64,
      content: "Optional: pick your timezone for local time parsing. Default stays America/New_York if you skip this.",
      components: [{
        type: 1,
        components: [{
          type: 3,
          custom_id: "timezone:select",
          placeholder: "Select your timezone (optional)",
          min_values: 1,
          max_values: 1,
          options: timezoneOptions.map((timeZone) => ({ label: timeZone, value: timeZone })),
        }],
      }],
    }),
  });
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

async function deliver(env: Env, eventId: string, userId: string, kind: "reminder" | "start" | "activation", channelId: string, content: string): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) return;
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO event_deliveries (event_id, user_id, kind, delivered_at) VALUES (?, ?, ?, ?)")
    .bind(eventId, userId, kind, new Date().toISOString()).run();
  if (!claimed.meta.changes) return;
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) await env.DB.prepare("DELETE FROM event_deliveries WHERE event_id = ? AND user_id = ? AND kind = ?")
    .bind(eventId, userId, kind).run();
}
function message(content: string, ephemeral: boolean): Response { return json({ type: ResponseType.ChannelMessage, data: { content, flags: ephemeral ? 64 : undefined } }); }
function publicEmbed(title: string, description: string): Response { return json({ type: ResponseType.ChannelMessage, data: { embeds: [{ title, description }] } }); }
function gameNames(games: Game[]): string { return games.map((game) => game.name).join(", "); }
