ALTER TABLE events RENAME TO events_previous;
ALTER TABLE event_rsvps RENAME TO event_rsvps_previous;
ALTER TABLE event_votes RENAME TO event_votes_previous;
ALTER TABLE event_games RENAME TO event_games_previous;
ALTER TABLE rsvps RENAME TO rsvps_previous;
ALTER TABLE event_game_votes RENAME TO event_game_votes_previous;
ALTER TABLE event_triggers RENAME TO event_triggers_previous;

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

CREATE TABLE event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('going', 'maybe', 'declined')),
  PRIMARY KEY (event_id, user_id)
);
INSERT INTO event_rsvps (event_id, user_id, status)
  SELECT event_id, user_id, status FROM event_rsvps_previous;

CREATE TABLE event_votes (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, user_id, game_id)
);
INSERT INTO event_votes (event_id, user_id, game_id)
  SELECT event_id, user_id, game_id FROM event_votes_previous;

CREATE TABLE event_games (
  event_id TEXT NOT NULL REFERENCES events(id),
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, game_id)
);
INSERT INTO event_games (event_id, game_id)
  SELECT event_id, game_id FROM event_games_previous;

CREATE TABLE rsvps (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('yes', 'maybe', 'no')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id)
);
INSERT INTO rsvps (event_id, user_id, status, updated_at)
  SELECT event_id, user_id, status, updated_at FROM rsvps_previous;

CREATE TABLE event_game_votes (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  PRIMARY KEY (event_id, user_id, game_id)
);
INSERT INTO event_game_votes (event_id, user_id, game_id)
  SELECT event_id, user_id, game_id FROM event_game_votes_previous;

CREATE TABLE event_triggers (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  type TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at TEXT
);
INSERT INTO event_triggers (event_id, type, threshold, fired_at)
  SELECT event_id, type, threshold, fired_at FROM event_triggers_previous;

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

DROP TABLE event_triggers_previous;
DROP TABLE event_game_votes_previous;
DROP TABLE rsvps_previous;
DROP TABLE event_games_previous;
DROP TABLE event_votes_previous;
DROP TABLE event_rsvps_previous;
DROP TABLE events_previous;
