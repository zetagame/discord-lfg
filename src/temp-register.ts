import worker from "./index";
import type { Env } from "./types";

const applicationId = "1535887039864774676";

const gameOption = { name: "games", description: "Games", type: 3, required: true, autocomplete: true };
const durationOption = { name: "duration", description: "Duration", type: 3 };
const commands = [
  { name: "listen", description: "Listen for game alerts", options: [gameOption, durationOption] },
  { name: "unlisten", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "mute", description: "Stop game alerts", options: [gameOption, durationOption] },
  { name: "lfg", description: "Post a looking-for-group alert", options: [gameOption, durationOption] },
  { name: "create", description: "Create a game event", options: [gameOption, { name: "when", description: "When", type: 3, required: true }] },
];

export default {
  ...worker,
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/register-commands") {
      if (!env.DISCORD_BOT_TOKEN) return new Response("DISCORD_BOT_TOKEN is not configured.", { status: 500 });

      const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
        method: "PUT",
        headers: {
          authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(commands),
      });
      const body = await response.text();
      if (!response.ok) return new Response(`Discord registration failed (${response.status}).\n${body}`, { status: 502 });

      return new Response("Registered Discord slash commands. This temporary endpoint can now be removed.");
    }

    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
