PRAGMA legacy_alter_table = ON;
PRAGMA foreign_keys = OFF;

ALTER TABLE events RENAME TO events_previous;
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  game_ids TEXT NOT NULL,
  starts_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  when_input TEXT
);
INSERT INTO events (id, guild_id, channel_id, author_id, title, game_ids, starts_at, created_at, when_input)
  SELECT id, guild_id, channel_id, author_id, title, game_ids, starts_at, created_at, when_input FROM events_previous;
DROP TABLE events_previous;

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
CREATE INDEX IF NOT EXISTS events_scheduled_start ON events (starts_at) WHERE starts_at IS NOT NULL;

PRAGMA foreign_keys = ON;
