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
   deployed Worker needs the five-minute Cron Trigger in `wrangler.jsonc` for
   event notifications, LFG expiry refreshes, and custom-game garbage collection.

`npm run typecheck` is an alias for the type check. For a remote D1 database,
use `npx wrangler d1 migrations apply discord-lfg --remote`.

## Continuous integration and deployment

GitHub Actions is CI-only: pull requests to `main` automatically run `npm ci`,
`npm run check`, and `npm test`. Production deployment is handled by Cloudflare
Workers Builds connected directly to this GitHub repository, which should use
`npm run deploy` to apply remote D1 migrations before deploying.

Set `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `IGDB_CLIENT_ID`, and
`IGDB_CLIENT_SECRET` as Cloudflare Worker secrets. Routine deployments require
no local Wrangler login.

## Commands

- `/lfg Games [Duration]` opens an availability window, valid for two hours by
  default. Its card shows the distinct number of currently available users for
  each selected game.
- `/create Games When` creates an RSVP event. The creator starts as Yes. One
  game has only RSVP buttons; multiple games also have a separate game-voting
  select.

There is no separate listen/mute state. LFG cards have a blue **Pause** button
and red **Stop** button. Pause removes that window from availability counts but
keeps its original expiry; after pausing, the blue button becomes **Resume**.
Stop permanently ends that LFG. Button interactions acknowledge immediately
with disabled loading controls, then update to the committed state; failures
restore the current card and return an ephemeral error.

Durations accept `30m`, `2h`, `3d`, `today`, `tonight`, `tomorrow`, `this
weekend`, `until 10pm`, and `until Friday`. Event times also accept scheduled
local timestamps such as `2026-08-09 20:00`, and trigger phrases such as
`3 yes RSVPs`.

## LFG behavior

Availability is derived only from active, unpaused, unexpired LFG windows.
Counts are distinct by user, so multiple active LFG records from one person do
not inflate a game's count.

When a new LFG or a resumed LFG creates a new overlap for a user/game pair, the
bot sends one deduplicated Discord message tagging the already-available users.
The message lists the newly overlapping games and their current counts. Creating
another LFG for a game the same user is already actively available for does not
create another overlap notification.

The Worker stores each LFG's Discord message ID. New overlaps, pause/resume,
stop, and expiry refresh affected LFG cards in place so per-game counts stay
current. Expiry is finalized by the existing five-minute scheduled Worker tick.

## Data behavior

Games use Discord autocomplete. Guild-local games and aliases are returned
first, IGDB supplements short local result sets, selected IGDB games are
cached with available cover metadata, and a typed value can be selected as a
guild-local custom game. IGDB OAuth tokens are reused safely within a Worker
instance until shortly before expiry.

Custom games can be soft-deleted by their creator; members with Manage Server
or Administrator can remove any custom game in the guild. Soft deletion hides
the game from future selection immediately. Physical deletion waits until no
open LFG or active event references it. Garbage collection runs on the initial
delete attempt, after an LFG is stopped, and on the scheduled Worker tick.

Users without an explicit IANA timezone use `America/New_York`. On first use,
the bot sends a one-time optional ephemeral timezone selector. Scheduled input
and local-calendar duration expressions are interpreted in that effective
timezone; scheduled timestamps are persisted as UTC.

Scheduled events have a UTC `starts_at`; trigger-based events have no
`starts_at` and activate when their persisted trigger is met. Yes RSVPs receive
a one-hour reminder before start plus a start notification at/after start.
Maybe RSVPs receive only the one-hour reminder window before start, and No RSVPs
receive neither. Reminder/start messages explicitly mention only the intended
user. Delivery records make Cron retries idempotent.

RSVP-count triggers atomically fire once, activate their event, and post an
activation notification. HTTP Interactions cannot observe Discord presence, so
people-online trigger definitions remain deferred until a presence source is
added.
