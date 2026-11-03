-- Idempotent: executed on every API start.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  model        TEXT,
  fw           INTEGER,
  battery_mv   INTEGER,
  battery_pct  SMALLINT,
  rssi         SMALLINT,
  interval_s   INTEGER NOT NULL DEFAULT 300,
  batch        SMALLINT NOT NULL DEFAULT 6,
  alert_min    REAL NOT NULL DEFAULT 2,
  alert_max    REAL NOT NULL DEFAULT 8,
  last_seen    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (device_id, ts) is the natural key: a node that retries a batch after a
-- lost HTTP response must not create duplicates.
CREATE TABLE IF NOT EXISTS readings (
  device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL,
  temperature  REAL NOT NULL,
  PRIMARY KEY (device_id, ts)
);
