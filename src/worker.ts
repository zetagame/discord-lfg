import worker from "./index";
import type { Env } from "./types";

async function registerCommands(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN) return new Response("DISCORD_BOT_TOKEN is missing.", { status: 500 });

  const applicationResponse = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!applicationResponse.ok) {
    return new Response(`Could not resolve Discord application (${applicationResponse.status}).`, { status: 502 });
  }
  const application = await applicationResponse.json() as { id?: string };
  if (!application.id) return new Response("Discord application id was missing.", { status: 502 });

  const commandsResponse = await worker.fetch(
    new Request(new URL("/commands", request.url), { method: "GET" }),
    env,
    ctx,
  );
  if (!commandsResponse.ok) return new Response("Could not load command schema.", { status: 500 });
  const commands = await commandsResponse.json();

  const response = await fetch(`https://discord.com/api/v10/applications/${application.id}/commands`, {
    method: "PUT",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!response.ok) {
    return new Response(`Discord command registration failed (${response.status}): ${await response.text()}`, { status: 502 });
  }

  const registered = await response.json() as unknown[];
  return Response.json({ ok: true, registered: registered.length });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/register-commands") {
      return registerCommands(request, env, ctx);
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
