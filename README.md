# discord-lfg

Minimal Discord LFG bot for Cloudflare Workers and D1. It uses Discord
Interactions over HTTP—no Gateway connection is needed.

## Setup

1. Create a D1 database: `npx wrangler d1 create discord-lfg`.
2. Replace `database_id` in `wrangler.jsonc` with its ID.
3. Create `.dev.vars` from `.env.example`. Set `DISCORD_PUBLIC_KEY`; add IGDB
   credentials to enable external search. Production secrets should be set with
   `npx wrangler secret put <NAME>`, not committed.
4. Apply the schema: `npx wrangler d1 migrations apply discord-lfg --local`
   (use `--remote` for production).
5. Deploy: `npm run deploy`. In Discord's Developer Portal, set the
   Interactions Endpoint URL to the worker URL.
6. Register the command JSON exposed at `GET /commands` with Discord's
   application-command endpoint using your application credentials.

## Commands

- `/watch` and `/unwatch` manage game alerts; `/mute` pauses all alerts.
- `/lfg` posts a public, lightweight LFG embed in the current channel.
- `/event` posts a public event with RSVP buttons and a multi-select game vote.

All game fields accept comma-separated game names and provide autocomplete.
Search uses games cached for the guild, then IGDB when configured, and finally
stores a typed name as a guild-local custom game. Internally each selection is
represented as a list of game IDs.

## Development

Run `npm run dev` for local Workers development and `npm run check` to type
check the source.