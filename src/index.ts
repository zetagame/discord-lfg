import { IgdbProvider, GameSelectionService } from "./games";
import { InteractionType, ResponseType, json, option, userId, verifyDiscordRequest } from "./discord";
import type { DiscordInteraction, Env, Game } from "./types";

const commands = [
  { name: "watch", description: "Listen for game alerts", options: [{ name: "games", description: "Games to watch (comma-separated)", type: 3, required: true, autocomplete: true }, { name: "minutes", description: "Temporarily mute alerts after watching", type: 4 }] },
  { name: "unwatch", description: "Stop listening for game alerts", options: [{ name: "games", description: "Games to stop watching (comma-separated)", type: 3, required: true, autocomplete: true }] },
  { name: "mute", description: "Temporarily stop game alerts", options: [{ name: "minutes", description: "Minutes to mute alerts", type: 4, required: true }] },
  { name: "lfg", description: "Post a looking-for-group alert", options: [{ name: "games", description: "Games to play (comma-separated)", type: 3, required: true, autocomplete: true }, { name: "starts", description: "When play starts", type: 3 }, { name: "note", description: "Details for the group", type: 3 }] },
  { name: "event", description: "Create a game event", options: [{ name: "games", description: "Games to choose from (comma-separated)", type: 3, required: true, autocomplete: true }, { name: "starts", description: "Event start time", type: 3, required: true }, { name: "title", description: "Event title", type: 3 }] },
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
} satisfies ExportedHandler<Env>;

async function autocomplete(interaction: DiscordInteraction, games: GameSelectionService): Promise<Response> {
  const focused = interaction.data?.options?.find((item) => item.focused);
  const parts = String(focused?.value ?? "").split(",");
  const query = parts.at(-1)?.trim() ?? "";
  const prefix = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean).join(", ");
  const found = await games.search(interaction.guild_id!, query);
  return json({ type: ResponseType.Autocomplete, data: { choices: found.slice(0, 25).map((game) => ({
    name: game.name,
    value: prefix ? `${prefix}, ${game.name}` : game.name,
  })) } });
}

async function command(interaction: DiscordInteraction, env: Env, games: GameSelectionService): Promise<Response> {
  const name = interaction.data?.name;
  const actor = userId(interaction)!;
  if (name === "mute") {
    const minutes = Number(option(interaction, "minutes"));
    if (!Number.isFinite(minutes) || minutes <= 0) return message("Enter a positive number of minutes.", true);
    await env.DB.prepare("UPDATE subscriptions SET muted_until = datetime('now', ? || ' minutes') WHERE guild_id = ? AND user_id = ?")
      .bind(String(minutes), interaction.guild_id, actor).run();
    return message(`Alerts muted for ${minutes} minutes.`, true);
  }
  try {
    const selected = await games.resolve(interaction.guild_id!, String(option(interaction, "games") ?? ""));
    if (name === "watch") return watch(interaction, env, selected);
    if (name === "unwatch") return unwatch(interaction, env, selected);
    if (name === "lfg") return lfg(interaction, env, selected);
    if (name === "event") return event(interaction, env, selected);
  } catch (error) {
    return message(error instanceof Error ? error.message : "Could not select games.", true);
  }
  return message("Unknown command.", true);
}

async function watch(i: DiscordInteraction, env: Env, games: Game[]): Promise<Response> {
  const muteMinutes = Number(option(i, "minutes") ?? 0);
  const muteUntil = muteMinutes > 0 ? new Date(Date.now() + muteMinutes * 60_000).toISOString() : null;
  await env.DB.batch(games.map((game) => env.DB.prepare("INSERT INTO subscriptions (guild_id, user_id, game_id, muted_until) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id, game_id) DO UPDATE SET muted_until = excluded.muted_until")
    .bind(i.guild_id, userId(i), game.id, muteUntil)));
  return message(`Watching: ${gameNames(games)}.`, true);
}

async function unwatch(i: DiscordInteraction, env: Env, games: Game[]): Promise<Response> {
  await env.DB.batch(games.map((game) => env.DB.prepare("DELETE FROM subscriptions WHERE guild_id = ? AND user_id = ? AND game_id = ?")
    .bind(i.guild_id, userId(i), game.id)));
  return message(`Stopped watching: ${gameNames(games)}.`, true);
}

async function lfg(i: DiscordInteraction, env: Env, games: Game[]): Promise<Response> {
  const starts = String(option(i, "starts") ?? "");
  const note = String(option(i, "note") ?? "");
  await env.DB.prepare("INSERT INTO lfg_posts (id, guild_id, channel_id, author_id, game_ids, starts_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), i.guild_id, i.channel_id, userId(i), JSON.stringify(games.map((game) => game.id)), starts || null, note || null).run();
  const placeholders = games.map(() => "?").join(",");
  const watchers = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM subscriptions WHERE guild_id = ? AND game_id IN (${placeholders}) AND (muted_until IS NULL OR muted_until <= CURRENT_TIMESTAMP)`,
  ).bind(i.guild_id, ...games.map((game) => game.id)).all<{ user_id: string }>();
  const mentions = watchers.results.map((watcher) => `<@${watcher.user_id}>`).join(" ");
  return publicEmbed("LFG", `${gameNames(games)}${starts ? `\nStarts: ${starts}` : ""}${note ? `\n${note}` : ""}${mentions ? `\nWatchers: ${mentions}` : ""}`);
}

async function event(i: DiscordInteraction, env: Env, games: Game[]): Promise<Response> {
  const id = crypto.randomUUID();
  const starts = String(option(i, "starts"));
  const title = String(option(i, "title") ?? "Game night");
  await env.DB.prepare("INSERT INTO events (id, guild_id, channel_id, author_id, title, game_ids, starts_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, i.guild_id, i.channel_id, userId(i), title, JSON.stringify(games.map((game) => game.id)), starts).run();
  return json({ type: ResponseType.ChannelMessage, data: { embeds: [{ title, description: `Games: ${gameNames(games)}\nStarts: ${starts}` }], components: [
    { type: 1, components: ["going", "maybe", "declined"].map((status) => ({ type: 2, style: status === "going" ? 3 : 2, label: status[0].toUpperCase() + status.slice(1), custom_id: `rsvp:${id}:${status}` })) },
    { type: 1, components: [{ type: 3, custom_id: `vote:${id}`, placeholder: "Vote for games", min_values: 1, max_values: games.length, options: games.map((game) => ({ label: game.name, value: game.id })) }] },
  ] } });
}

async function component(i: DiscordInteraction, env: Env): Promise<Response> {
  const [action, eventId, status] = i.data?.custom_id?.split(":") ?? [];
  if (!eventId) return message("Invalid event action.", true);
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND guild_id = ?").bind(eventId, i.guild_id).first();
  if (!event) return message("This event is not available in this server.", true);
  if (action === "rsvp" && status) {
    await env.DB.prepare("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status")
      .bind(eventId, userId(i), status).run();
    return message(`RSVP updated to ${status}.`, true);
  }
  if (action === "vote") {
    const values = i.data?.values ?? [];
    await env.DB.batch([env.DB.prepare("DELETE FROM event_votes WHERE event_id = ? AND user_id = ?").bind(eventId, userId(i)), ...values.map((gameId) => env.DB.prepare("INSERT INTO event_votes (event_id, user_id, game_id) VALUES (?, ?, ?)").bind(eventId, userId(i), gameId))]);
    return message("Game vote recorded.", true);
  }
  return message("Invalid event action.", true);
}

function message(content: string, ephemeral: boolean): Response {
  return json({ type: ResponseType.ChannelMessage, data: { content, flags: ephemeral ? 64 : undefined } });
}
function publicEmbed(title: string, description: string): Response {
  return json({ type: ResponseType.ChannelMessage, data: { embeds: [{ title, description }] } });
}
function gameNames(games: Game[]): string { return games.map((game) => game.name).join(", "); }
