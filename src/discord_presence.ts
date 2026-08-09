import type { Env } from "./types";

type VoiceState = { channel_id?: string | null };

export async function lfgMemberLines(env: Env, guildId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  if (!env.DISCORD_BOT_TOKEN) return userIds.map((userId) => `• <@${userId}>`);

  return Promise.all(userIds.map(async (userId) => {
    const voice = await discordGet<VoiceState>(env, `/guilds/${guildId}/voice-states/${userId}`, true);
    return voice?.channel_id
      ? `• <@${userId}> — 🔊 <#${voice.channel_id}>`
      : `• <@${userId}>`;
  }));
}

async function discordGet<T>(env: Env, path: string, quiet404 = false): Promise<T | undefined> {
  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (response.status === 404 && quiet404) return undefined;
    if (!response.ok) {
      console.error("Discord API read failed", path, response.status, await response.text());
      return undefined;
    }
    return await response.json() as T;
  } catch (error) {
    console.error("Discord API read request failed", path, error);
    return undefined;
  }
}
