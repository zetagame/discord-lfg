const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_COMMANDS_URL } = process.env;
const commandsUrl = DISCORD_COMMANDS_URL ?? "http://127.0.0.1:8787/commands";
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN) throw new Error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN.");
const commands = await (await fetch(commandsUrl)).json();
const response = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
if (!response.ok) throw new Error(`Discord command registration failed: ${response.status}`);
