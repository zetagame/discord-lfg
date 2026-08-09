CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  timezone TEXT,
  timezone_prompted_at TEXT,
  PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE games ADD COLUMN cover_url TEXT;
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

ALTER TABLE events ADD COLUMN when_input TEXT;
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
