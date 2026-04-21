import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  host          TEXT PRIMARY KEY,
  name          TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  event_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  host          TEXT NOT NULL,
  started_epoch INTEGER NOT NULL,
  ended_epoch   INTEGER,
  duration_secs REAL,
  classes       TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  image_file    TEXT,
  clip_file     TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_host_started
  ON events(host, started_epoch DESC);
CREATE INDEX IF NOT EXISTS events_started
  ON events(started_epoch DESC);

CREATE TABLE IF NOT EXISTS phases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL,
  phase         TEXT NOT NULL,
  detail        TEXT,
  epoch         INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS phases_event ON phases(event_id, epoch);
`);

export const stmts = {
  upsertDevice: db.prepare(`
    INSERT INTO devices (host, name, first_seen, last_seen, event_count)
    VALUES (@host, @name, @now, @now, 0)
    ON CONFLICT(host) DO UPDATE SET last_seen = excluded.last_seen
  `),
  registerDevice: db.prepare(`
    INSERT INTO devices (host, name, first_seen, last_seen, event_count)
    VALUES (@host, @name, @now, @now, 0)
    ON CONFLICT(host) DO UPDATE SET name = COALESCE(excluded.name, devices.name)
  `),
  bumpDeviceEvents: db.prepare(
    `UPDATE devices SET event_count = event_count + 1 WHERE host = ?`
  ),
  listDevices: db.prepare(
    `SELECT host, name, first_seen, last_seen, event_count FROM devices ORDER BY last_seen DESC`
  ),

  getEvent: db.prepare(`SELECT * FROM events WHERE event_id = ?`),
  insertEvent: db.prepare(`
    INSERT INTO events (event_id, host, started_epoch, classes, status, image_file, updated_at)
    VALUES (@event_id, @host, @started_epoch, @classes, 'active', @image_file, @now)
  `),
  updateEventEnd: db.prepare(`
    UPDATE events
       SET status = 'ended',
           ended_epoch = @ended_epoch,
           duration_secs = @duration_secs,
           clip_file = COALESCE(@clip_file, clip_file),
           updated_at = @now
     WHERE event_id = @event_id
  `),
  updateEventTouch: db.prepare(`
    UPDATE events SET updated_at = @now, duration_secs = COALESCE(@duration_secs, duration_secs) WHERE event_id = @event_id
  `),

  listEvents: db.prepare(`
    SELECT * FROM events
     WHERE (@host IS NULL OR host = @host)
       AND started_epoch >= @since
     ORDER BY started_epoch DESC
     LIMIT @limit OFFSET @offset
  `),
  deleteOldEvents: db.prepare(
    `DELETE FROM events WHERE started_epoch < ?`
  ),

  insertPhase: db.prepare(`
    INSERT INTO phases (event_id, phase, detail, epoch, payload)
    VALUES (@event_id, @phase, @detail, @epoch, @payload)
  `),
  phasesForEvent: db.prepare(
    `SELECT phase, detail, epoch, payload FROM phases WHERE event_id = ? ORDER BY epoch ASC, id ASC`
  ),
};

export function upsertDevice(host, now) {
  stmts.upsertDevice.run({ host, name: null, now });
}
