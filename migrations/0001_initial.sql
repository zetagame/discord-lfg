CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, name)
);

CREATE INDEX IF NOT EXISTS games_guild_name ON games (guild_id, name);

CREATE TABLE IF NOT EXISTS subscriptions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  muted_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id, game_id)
);

CREATE TABLE IF NOT EXISTS lfg_posts (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  game_ids TEXT NOT NULL,
  starts_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  game_ids TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('going', 'maybe', 'declined')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_votes (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, user_id, game_id)
);
