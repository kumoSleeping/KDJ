CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  categories TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(length(body) <= 262144)
);
CREATE INDEX IF NOT EXISTS reports_received ON reports(received_at, id);
