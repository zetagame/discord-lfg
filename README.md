# discord-lfg

A Cloudflare Worker Discord bot backed by D1. It receives signed Discord
Interactions over HTTP; it does not require a Gateway connection.

## Local development and deployment

1. Create a Discord application and bot in the Discord Developer Portal. Copy
   its public key, application ID, and bot token. Configure the deployed
   worker's `/` URL as the application's **Interactions Endpoint URL**.
2. Create a D1 database with `npx wrangler d1 create discord-lfg`, then replace
   `database_id` in `wrangler.jsonc`.
3. Copy `.env.example` to `.dev.vars` and set `DISCORD_PUBLIC_KEY` and
   `DISCORD_BOT_TOKEN`. Add `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` to enable
   IGDB search. Set production values with `npx wrangler secret put NAME`;
   never commit secrets.
4. Run `npm run migrations`, then `npm run dev`.
5. Set `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` locally, and run
   `npm run register-commands` while the development worker is running. Set
   `DISCORD_COMMANDS_URL` to the deployed worker's `/commands` URL to register
   production commands.
6. Run `npm run check`, `npm test`, and `npm run deploy` as appropriate. The
   deployed Worker needs the five-minute Cron Trigger in `wrangler.jsonc` to
   check D1 for event lifecycle notifications.

`npm run typecheck` is an alias for the type check. For a remote D1 database,
use `npx wrangler d1 migrations apply discord-lfg --remote`.

## Continuous integration and deployment

GitHub Actions is CI-only: pull requests to `main` automatically run `npm ci`,
`npm run check`, and `npm test`. Production deployment is handled by Cloudflare
Workers Builds connected directly to this GitHub repository.

Set `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `IGDB_CLIENT_ID`, and
`IGDB_CLIENT_SECRET` as Cloudflare Worker secrets. Routine deployments require
no local Wrangler login.

## Commands

- `/listen Games [Duration]` appends a listening instruction.
- `/unlisten Games [Duration]` appends an unlistening instruction.
- `/mute Games [Duration]` is exactly `/unlisten`; it stores the same
  instruction and uses the same precedence rules.
- `/lfg Games [Duration]` posts a lightweight public alert, valid for two
  hours by default, and mentions each matching listener once (never its
  creator).
- `/create Games When` creates an RSVP event. One game has only RSVP buttons;
  multiple games also have a separate game-voting select.

Durations accept `30m`, `2h`, `3d`, `today`, `tonight`, `tomorrow`, `this
weekend`, `until 10pm`, and `until Friday`. Event times also accept scheduled
local timestamps such as `2026-08-09 20:00`, and initial trigger phrases such
as `3 yes RSVPs`.

## Data behavior

Games use Discord autocomplete. Guild-local games and aliases are returned
first, IGDB supplements short local result sets, selected IGDB games are
cached with available cover metadata, and a typed value can be selected as a
guild-local custom game. IGDB OAuth tokens are reused safely within a Worker
instance until shortly before expiry.

Notification state is append-only. For each guild/user/game, all unexpired
instructions are considered and the newest instruction wins. Expiring a
temporary listen or unlisten reveals the prior instruction; no prior state is
deleted or overwritten.

Users without an explicit IANA timezone use `America/New_York`. Scheduled
input and local-calendar duration expressions are interpreted in that effective
timezone; scheduled timestamps are persisted as UTC.

Scheduled events have a UTC `starts_at`; trigger-based events have no
`starts_at` and activate when their persisted trigger is met. Yes RSVPs receive
a one-hour reminder before start plus a start notification at/after start.
Maybe RSVPs receive only the one-hour reminder window before start, and No RSVPs
receive neither. Delivery records make Cron retries idempotent.
RSVP-count triggers atomically fire once, activate their event, and post an
activation notification.

HTTP Interactions cannot observe guild-member joins, so a no-Gateway deployment
cannot currently prompt at join or evaluate online-presence triggers. On first
use without an explicit timezone, the bot sends a one-time optional ephemeral
timezone selector; if ignored, parsing still uses the `America/New_York`
fallback. Trigger definitions for people online and listeners online are
retained for future Gateway presence input; only RSVP-count triggers are
evaluated by the HTTP-only Worker.
