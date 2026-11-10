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

-- 调度真源：一行一个待办。state 只走 pending -> leased -> done|dead。
-- 主动额度用「今天 pending/leased 的 proactive 行数」当预留，失败/死亡自动退额。
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  unit TEXT NOT NULL,
  kind TEXT NOT NULL,          -- reply|burst|proactive|proactive_tick|life_day
  state TEXT NOT NULL DEFAULT 'pending',
  due_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(state, due_at);
CREATE INDEX IF NOT EXISTS ix_jobs_owner ON jobs(user, unit, kind, state);

-- 调度心跳：让「清扫没跑」可见，而不是静默卡死。
CREATE TABLE IF NOT EXISTS cron_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_drain_at INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  leased INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  ensured_at INTEGER NOT NULL DEFAULT 0,
  jobs_migrated INTEGER NOT NULL DEFAULT 0
);
