CREATE TABLE IF NOT EXISTS conversations (
  user TEXT NOT NULL,
  unit TEXT NOT NULL,
  npc_read_seq INTEGER NOT NULL DEFAULT 0,
  user_seen_seq INTEGER NOT NULL DEFAULT 0,
  reply_due_at INTEGER,
  turn_id TEXT,
  turn_expires_at INTEGER,
  turn_kind TEXT,
  glow_until INTEGER NOT NULL DEFAULT 0,
  burst_left INTEGER NOT NULL DEFAULT 0,
  proactive_date TEXT,
  proactive_sent INTEGER NOT NULL DEFAULT 0,
  proactive_last_at INTEGER NOT NULL DEFAULT 0,
  proactive_counted INTEGER NOT NULL DEFAULT 1,
  engagement REAL NOT NULL DEFAULT 0.15,
  engagement_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, unit)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  unit TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('me', 'ai')),
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  t INTEGER NOT NULL,
  client_id TEXT,
  turn_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  pushed_at INTEGER,
  push_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_client
  ON messages(user, unit, client_id);
CREATE INDEX IF NOT EXISTS ix_msg_tail
  ON messages(user, unit, id);

CREATE TABLE IF NOT EXISTS devices (
  user TEXT NOT NULL,
  device_id TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user, device_id)
);

CREATE TABLE IF NOT EXISTS prefs (
  user TEXT PRIMARY KEY,
  notif TEXT NOT NULL DEFAULT 'preview',
  tz_offset INTEGER NOT NULL DEFAULT -480,
  migrated INTEGER NOT NULL DEFAULT 0
);
