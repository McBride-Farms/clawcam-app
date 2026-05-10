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
  event_count   INTEGER NOT NULL DEFAULT 0,
  system_prompt TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id              TEXT PRIMARY KEY,
  host                  TEXT NOT NULL,
  started_epoch         INTEGER NOT NULL,
  ended_epoch           INTEGER,
  duration_secs         REAL,
  classes               TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  image_file            TEXT,
  clip_file             TEXT,
  vision_caption        TEXT,
  vision_interest_level INTEGER,
  vision_suggested_action TEXT,
  updated_at            INTEGER NOT NULL
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

// Lightweight migration for DBs created before later columns were added.
// SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we feature-detect.
{
  interface ColumnInfo { name: string }
  const ensureCol = (table: string, name: string, type: string): void => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
    const cols = new Set(rows.map((c) => c.name));
    if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  ensureCol("events", "vision_caption", "TEXT");
  ensureCol("events", "vision_interest_level", "INTEGER");
  ensureCol("events", "vision_suggested_action", "TEXT");
  ensureCol("devices", "system_prompt", "TEXT");
}

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
    `SELECT host, name, first_seen, last_seen, event_count, system_prompt FROM devices ORDER BY last_seen DESC`
  ),
  getDevice: db.prepare(
    `SELECT host, name, first_seen, last_seen, event_count, system_prompt FROM devices WHERE host = ?`
  ),
  setDeviceSystemPrompt: db.prepare(
    `UPDATE devices SET system_prompt = @system_prompt WHERE host = @host`
  ),

  getEvent: db.prepare(`SELECT * FROM events WHERE event_id = ?`),
  insertEvent: db.prepare(`
    INSERT INTO events (
      event_id, host, started_epoch, classes, status, image_file,
      vision_caption, vision_interest_level, vision_suggested_action, updated_at
    )
    VALUES (
      @event_id, @host, @started_epoch, @classes, 'active', @image_file,
      @vision_caption, @vision_interest_level, @vision_suggested_action, @now
    )
  `),
  // Vision fields can arrive on a later phase (e.g. transform computes them
  // for `end` but not `start`). Only overwrite when the caption is non-empty
  // — that's our "did vision succeed?" signal — so a failed second call
  // doesn't blank out a successful first one.
  updateEventVision: db.prepare(`
    UPDATE events
       SET vision_caption = @vision_caption,
           vision_interest_level = @vision_interest_level,
           vision_suggested_action = @vision_suggested_action,
           updated_at = @now
     WHERE event_id = @event_id
       AND @vision_caption IS NOT NULL
       AND @vision_caption != ''
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

export function upsertDevice(host: string, now: number): void {
  stmts.upsertDevice.run({ host, name: null, now });
}
