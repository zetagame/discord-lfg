CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  timezone TEXT,
  timezone_prompted_at TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cover_url TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, name)
);

CREATE INDEX IF NOT EXISTS games_guild_name ON games (guild_id, name);

CREATE TABLE IF NOT EXISTS game_aliases (
  guild_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (guild_id, alias)
);

CREATE TABLE IF NOT EXISTS notification_actions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  action TEXT NOT NULL CHECK(action IN ('listen', 'unlisten')),
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS notification_actions_lookup ON notification_actions (guild_id, game_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lfgs (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lfg_games (
  lfg_id TEXT NOT NULL REFERENCES lfgs(id),
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (lfg_id, game_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT,
  when_input TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS events_scheduled_start ON events (starts_at) WHERE starts_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_games (
  event_id TEXT NOT NULL REFERENCES events(id),
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, game_id)
);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('yes', 'maybe', 'no')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_game_votes (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, user_id, game_id)
);

CREATE TABLE IF NOT EXISTS event_triggers (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  type TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at TEXT
);

CREATE TABLE IF NOT EXISTS event_activations (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  activated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_deliveries (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reminder', 'start', 'activation')),
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id, kind)
);
