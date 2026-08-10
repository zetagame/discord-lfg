import worker from "./index";
import { currentControlMessageForInteraction, rebindControlSessionMessage } from "./control_sessions";
import { debugCommand, handleDebugCommand } from "./debug";
import { InteractionType, ResponseType, userId, verifyDiscordRequest } from "./discord";
import type { DiscordInteraction, Env } from "./types";

const ACK_BUDGET_MS = 1_750;
const EPHEMERAL = 1 << 6;
const IS_COMPONENTS_V2 = 1 << 15;

type DeferredSpec = {
  type: typeof ResponseType.DeferredChannelMessage | typeof ResponseType.DeferredUpdateMessage;
  flags?: number;
  recreateAfterCompletion?: boolean;
};

type CallbackResponse = {
  type?: number;
  data?: Record<string, unknown>;
};

type SettledResponse =
  | { ok: true; response: Response }
  | { ok: false; error: unknown };

async function commandSchema(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = await worker.fetch(new Request(new URL("/commands", request.url), { method: "GET" }), env, ctx);
  if (!response.ok) return response;
  const commands = await response.json() as unknown[];
  return Response.json([...commands, debugCommand]);
}

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

  const commandsResponse = await commandSchema(request, env, ctx);
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
    const isLfg = interaction.data?.name === "lfg";
    return {
      type: ResponseType.DeferredChannelMessage,
      flags: isLfg ? EPHEMERAL | IS_COMPONENTS_V2 : undefined,
      recreateAfterCompletion: isLfg,
    };
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
      return { type: ResponseType.DeferredUpdateMessage };
    }
    return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL };
  }

  if (action === "event-delete" || action === "rsvp") {
    return { type: ResponseType.DeferredUpdateMessage };
  }
  return { type: ResponseType.DeferredChannelMessage, flags: EPHEMERAL };
}

async function withAckBudget(
  interaction: DiscordInteraction,
  operation: Promise<Response>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const spec = deferredSpec(interaction);
  if (!spec) return operation;

  const settled: Promise<SettledResponse> = operation.then(
    (response) => ({ ok: true as const, response }),
    (error) => ({ ok: false as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ACK_BUDGET_MS);
  });
  const fast = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);

  if (fast) {
    if (fast.ok) return fast.response;
    console.error("Discord interaction failed before acknowledgement", fast.error);
    return Response.json({
      type: ResponseType.ChannelMessage,
      data: { content: "Could not complete that interaction.", flags: EPHEMERAL },
    });
  }

  ctx.waitUntil(finalizeDeferred(interaction, settled, spec, env));
  return deferredResponse(spec);
}

function deferredResponse(spec: DeferredSpec): Response {
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
  env: Env,
): Promise<void> {
  const [result, originalReady] = await Promise.all([
    settled,
    waitForDeferredOriginal(interaction),
  ]);
  if (!originalReady) {
    console.error("Discord deferred response never became observable; leaving its processing state intact");
    return;
  }
  if (!result.ok) {
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
      await editInteractionOriginal(interaction, data);
      return;
    }
    if (callback.type === ResponseType.ChannelMessage) {
      await postInteractionFollowup(interaction, data);
      return;
    }
  }

  if (spec.type === ResponseType.DeferredChannelMessage && callback.type === ResponseType.ChannelMessage) {
    if (spec.recreateAfterCompletion) {
      await recreateDeferredLfgManager(interaction, data, env);
      return;
    }
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

async function waitForDeferredOriginal(interaction: DiscordInteraction): Promise<boolean> {
  if (!interaction.application_id) return false;
  for (const delay of [0, 50, 100, 250, 500, 1_000, 1_500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(
        `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      );
      if (response.ok) return true;
      if (response.status === 404) continue;
      console.error("Deferred interaction original lookup failed", response.status, await response.text());
      return false;
    } catch (error) {
      if (delay === 1_500) console.error("Deferred interaction original lookup request failed", error);
    }
  }
  return false;
}

async function recreateDeferredLfgManager(
  interaction: DiscordInteraction,
  data: Record<string, unknown>,
  env: Env,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actor = userId(interaction);
  if (!guildId || !actor) {
    const { flags: _flags, ...editable } = data;
    await editInteractionOriginal(interaction, editable);
    return;
  }

  let originalManagerId: string | undefined;
  for (const delay of [0, 50, 100, 250, 500, 750]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    originalManagerId = await currentControlMessageForInteraction(env.DB, guildId, actor, interaction.token);
    if (originalManagerId) break;
  }
  if (!originalManagerId) {
    console.error("Deferred /lfg manager session was not promoted in time; preserving original manager");
    const { flags: _flags, ...editable } = data;
    await editInteractionOriginal(interaction, editable);
    return;
  }

  if (!await deleteInteractionOriginal(interaction)) {
    const { flags: _flags, ...editable } = data;
    await editInteractionOriginal(interaction, editable);
    return;
  }

  const finalMessageId = await postInteractionFollowupMessage(interaction, data);
  if (!finalMessageId) return;
  if (!await rebindControlSessionMessage(
    env.DB,
    guildId,
    actor,
    interaction.token,
    originalManagerId,
    finalMessageId,
  )) {
    console.error("Deferred /lfg manager was created but its control session could not be rebound");
  }
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
  return Boolean(await postInteractionFollowupMessage(interaction, data));
}

async function postInteractionFollowupMessage(
  interaction: DiscordInteraction,
  data: Record<string, unknown>,
): Promise<string | undefined> {
  if (!interaction.application_id) return undefined;
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}?wait=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    if (!response.ok) {
      console.error("Deferred interaction followup failed", response.status, await response.text());
      return undefined;
    }
    return (await response.json() as { id?: string }).id;
  } catch (error) {
    console.error("Deferred interaction followup request failed", error);
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/commands") {
      return commandSchema(request, env, ctx);
    }
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
    if (interaction.type === InteractionType.ApplicationCommand && interaction.data?.name === "debug") {
      const verified = await verifyDiscordRequest(request.clone(), env.DISCORD_PUBLIC_KEY);
      if (!verified) return new Response("Invalid request signature", { status: 401 });
      return withAckBudget(verified, handleDebugCommand(verified, env), env, ctx);
    }
    return withAckBudget(interaction, worker.fetch(request, env, ctx), env, ctx);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
