import type { Env } from "./types";

type GuildMember = {
  nick?: string | null;
  user?: { username?: string; global_name?: string | null };
};

type VoiceState = { channel_id?: string | null };
type DiscordChannel = { id: string; name?: string };

export async function lfgMemberLines(env: Env, guildId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  if (!env.DISCORD_BOT_TOKEN) return userIds.map((id) => id);

  const members = await Promise.all(userIds.map(async (userId) => {
    const [member, voice] = await Promise.all([
      discordGet<GuildMember>(env, `/guilds/${guildId}/members/${userId}`),
      discordGet<VoiceState>(env, `/guilds/${guildId}/voice-states/${userId}`, true),
    ]);
    return {
      userId,
      name: member?.nick ?? member?.user?.global_name ?? member?.user?.username ?? userId,
      channelId: voice?.channel_id ?? undefined,
    };
  }));

  const channelIds = [...new Set(members.map((member) => member.channelId).filter((id): id is string => Boolean(id)))];
  const channels = new Map<string, string>();
  await Promise.all(channelIds.map(async (channelId) => {
    const channel = await discordGet<DiscordChannel>(env, `/channels/${channelId}`, true);
    if (channel?.name) channels.set(channelId, channel.name);
  }));

  return members.map((member) => {
    const name = escapeMarkdown(member.name);
    const voiceName = member.channelId ? channels.get(member.channelId) : undefined;
    return voiceName ? `• ${name} — 🔊 ${escapeMarkdown(voiceName)}` : `• ${name}`;
  });
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

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, "\\$&");
}
