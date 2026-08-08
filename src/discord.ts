import type { DiscordInteraction } from "./types";

export const InteractionType = { Ping: 1, ApplicationCommand: 2, Component: 3, Autocomplete: 4 } as const;
export const ResponseType = { Pong: 1, ChannelMessage: 4, Autocomplete: 8, UpdateMessage: 7 } as const;

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
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
