import worker from "./index";
import { InteractionType, ResponseType } from "./discord";
import type { DiscordInteraction, Env } from "./types";

const ACK_BUDGET_MS = 1_750;
const EPHEMERAL = 1 << 6;
const IS_COMPONENTS_V2 = 1 << 15;

type DeferredSpec = {
  type: typeof ResponseType.DeferredChannelMessage | typeof ResponseType.DeferredUpdateMessage;
  flags?: number;
  ignoreUpdateResult?: boolean;
};

type CallbackResponse = {
  type?: number;
  data?: Record<string, unknown>;
};

type SettledResponse =
  | { response: Response; error?: never }
  | { response?: never; error: unknown };

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

function deferredSpec(interaction: DiscordInteraction): DeferredSpec | undefined {
  if (interaction.type === InteractionType.ApplicationCommand) {
    const flags = interaction.data?.name === "lfg" ? EPHEMERAL | IS_COMPONENTS_V2 : undefined;
    return { type: ResponseType.DeferredChannelMessage, flags };
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL };
  }

  if (interaction.type !== InteractionType.Component) return undefined;
  const parts = interaction.data?.custom_id?.split(":") ?? [];
  const action = parts[0];
  const sub = parts[1];

  if (action === "group") {
    if (sub === "manage") {
      return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL | IS_COMPONENTS_V2 };
    }
    if (sub === "pause" || sub === "resume" || sub === "stop") {
      return { type: ResponseType.DeferredUpdateMessage, ignoreUpdateResult: true };
    }
    return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL };
  }

  if (action === "event-delete") {
    return { type: ResponseType.DeferredUpdateMessage, ignoreUpdateResult: true };
  }
  if (action === "rsvp") return { type: ResponseType.DeferredUpdateMessage };
  return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL };
}

async function withAckBudget(
  interaction: DiscordInteraction,
  operation: Promise<Response>,
  ctx: ExecutionContext,
): Promise<Response> {
  const spec = deferredSpec(interaction);
  if (!spec) return operation;

  const settled: Promise<SettledResponse> = operation.then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ACK_BUDGET_MS);
  });
  const fast = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);

  if (fast) {
    if (fast.response) return fast.response;
    console.error("Discord interaction failed before acknowledgement", fast.error);
    return Response.json({
      type: ResponseType.ChannelMessage,
      data: { content: "Could not complete that interaction.", flags: EPHEMERAL },
    });
  }

  ctx.waitUntil(finalizeDeferred(interaction, settled, spec));
  return Response.json({
    type: spec.type,
    ...(spec.type === ResponseType.DeferredChannelMessage && spec.flags !== undefined
      ? { data: { flags: spec.flags } }
      : {}),
  });
}

async function finalizeDeferred(
  interaction: DiscordInteraction,
  settled: Promise<SettledResponse>,
  spec: DeferredSpec,
): Promise<void> {
  const result = await settled;
  if (result.error) {
    console.error("Discord interaction failed after deferred acknowledgement", result.error);
    await finishDeferredError(interaction, spec);
    return;
  }

  let callback: CallbackResponse;
  try {
    callback = await result.response.json() as CallbackResponse;
  } catch (error) {
    console.error("Deferred interaction returned a non-JSON response", error);
    await finishDeferredError(interaction, spec);
    return;
  }

  const data = callback.data ?? {};
  if (spec.type === ResponseType.DeferredUpdateMessage) {
    if (callback.type === ResponseType.UpdateMessage) {
      if (!spec.ignoreUpdateResult) await editInteractionOriginal(interaction, data);
      return;
    }
    if (callback.type === ResponseType.ChannelMessage) {
      await postInteractionFollowup(interaction, data);
      return;
    }
  }

  if (spec.type === ResponseType.DeferredChannelMessage && callback.type === ResponseType.ChannelMessage) {
    const finalFlags = typeof data.flags === "number" ? data.flags : 0;
    const deferredFlags = spec.flags ?? 0;
    const immutableFlagsChanged = ((finalFlags ^ deferredFlags) & (EPHEMERAL | IS_COMPONENTS_V2)) !== 0;
    if (immutableFlagsChanged) {
      await deleteInteractionOriginal(interaction);
      await postInteractionFollowup(interaction, data);
      return;
    }
    const { flags: _flags, ...editable } = data;
    await editInteractionOriginal(interaction, editable);
    return;
  }

  console.error("Deferred interaction callback type did not match acknowledgement mode", callback.type, spec.type);
  await finishDeferredError(interaction, spec);
}

async function finishDeferredError(interaction: DiscordInteraction, spec: DeferredSpec): Promise<void> {
  const data = { content: "Could not complete that interaction.", flags: EPHEMERAL };
  if (spec.type === ResponseType.DeferredChannelMessage && (spec.flags ?? 0) & EPHEMERAL) {
    await editInteractionOriginal(interaction, { content: data.content, components: [], embeds: [] });
    return;
  }
  await postInteractionFollowup(interaction, data);
}

async function editInteractionOriginal(interaction: DiscordInteraction, data: Record<string, unknown>): Promise<boolean> {
  if (!interaction.application_id) return false;
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    if (!response.ok) console.error("Deferred interaction edit failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error("Deferred interaction edit request failed", error);
    return false;
  }
}

async function deleteInteractionOriginal(interaction: DiscordInteraction): Promise<boolean> {
  if (!interaction.application_id) return false;
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      console.error("Deferred interaction delete failed", response.status, await response.text());
    }
    return response.ok || response.status === 404;
  } catch (error) {
    console.error("Deferred interaction delete request failed", error);
    return false;
  }
}

async function postInteractionFollowup(interaction: DiscordInteraction, data: Record<string, unknown>): Promise<boolean> {
  if (!interaction.application_id) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) console.error("Deferred interaction followup failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error("Deferred interaction followup request failed", error);
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/register-commands") {
      return registerCommands(request, env, ctx);
    }
    if (request.method !== "POST") return worker.fetch(request, env, ctx);

    let interaction: DiscordInteraction | undefined;
    try {
      interaction = await request.clone().json() as DiscordInteraction;
    } catch {
      return worker.fetch(request, env, ctx);
    }
    if (interaction.type === InteractionType.Ping || interaction.type === InteractionType.Autocomplete) {
      return worker.fetch(request, env, ctx);
    }
    return withAckBudget(interaction, worker.fetch(request, env, ctx), ctx);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
