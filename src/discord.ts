import type { DiscordInteraction } from "./types";

export const InteractionType = { Ping: 1, ApplicationCommand: 2, Component: 3, Autocomplete: 4, ModalSubmit: 5 } as const;
export const ResponseType = { Pong: 1, ChannelMessage: 4, Autocomplete: 8, UpdateMessage: 7, Modal: 9 } as const;

export function json(body: unknown): Response {
  return new Response(JSON.stringify(chainAutocompleteChoices(body)), { headers: { "content-type": "application/json" } });
}

/**
 * The bot currently has one autocomplete surface: the comma-delimited game
 * field shared by /lfg and /create. The visible choice text must carry the same
 * accumulated value as the submitted choice; otherwise Discord shows only the
 * current game's label and selecting it does not leave the comma in the field.
 */
export function chainAutocompleteChoices(body: unknown): unknown {
  if (!isAutocompleteResponse(body)) return body;
  return {
    ...body,
    data: {
      ...body.data,
      choices: body.data.choices.map((choice) => {
        if (typeof choice.value !== "string") return choice;
        const chained = choice.value.endsWith(", ")
          ? choice.value
          : choice.value.length <= 98 ? `${choice.value}, ` : choice.value;
        return { ...choice, name: chained, value: chained };
      }),
    },
  };
}

function isAutocompleteResponse(body: unknown): body is {
  type: number;
  data: { choices: Array<{ name: string; value: string | number }> };
} {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { type?: unknown; data?: { choices?: unknown } };
  return candidate.type === ResponseType.Autocomplete && Array.isArray(candidate.data?.choices);
}

export async function verifyDiscordRequest(request: Request, publicKey: string): Promise<DiscordInteraction | null> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return null;
  const body = await request.text();
  try {
    const key = await crypto.subtle.importKey("raw", buffer(hex(publicKey)), { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, buffer(hex(signature)), buffer(new TextEncoder().encode(timestamp + body)));
    return valid ? JSON.parse(body) as DiscordInteraction : null;
  } catch {
    return null;
  }
}

function hex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64,}$/i.test(value) || value.length % 2) throw new Error("Invalid hex");
  return Uint8Array.from(value.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
}

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function option(interaction: DiscordInteraction, name: string): string | number | boolean | undefined {
  return interaction.data?.options?.find((item) => item.name === name)?.value;
}

export function userId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}
