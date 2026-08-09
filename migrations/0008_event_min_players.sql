ALTER TABLE events ADD COLUMN min_players INTEGER CHECK(min_players IS NULL OR min_players > 0);

CREATE TABLE IF NOT EXISTS event_min_player_checks (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  checked_at TEXT NOT NULL,
  yes_count INTEGER NOT NULL,
  alerted_at TEXT
);
