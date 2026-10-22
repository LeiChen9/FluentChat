// 主动消息调度：persona 会自己开口。每分钟抽签，命中才真发。
// 数字都来自 contact.json 的 proactive 字段（谁不配谁不发）：
//   perDay  [lo, hi] —— 每天期望次数区间；engagement 0→lo、1→hi
//   windows [[from,to], ...] —— 小时段开窗（24 当当天 24:00 用 1440 分钟算）
// 频率与人设走配置，剩下一件事是交互反馈：engagement 分 (0-1)：
//   用户每说一句 + 一点，半天没人理每条主动消息过两小时一次衰减 ×0.6，
//   每次 tick 再做慢衰减 —— 冷场越久开口越少，聊得热络约高发。
// 发送条件在这里只看状态：offline 永不主动，away/busy 命中率减半，
// 「发之前升 active」由调用方在真正开口那一刻做（rhythm.noteReply）。

import { statusOf } from "./rhythm.js";

const ENG_KEY = "fluentchat:engage:v1:";
const PRO_KEY = "fluentchat:proactive:v1:"; // { date, sent, lastAt, counted }
const ENG_DEFAULT = 0.15;   // 初见：低分 → 每天 ≤1 条主动，聊过几句就上来
const ENG_DECAY = 0.9997;   // 每分钟慢衰减（半衰期 ~19h）：不瞅它时仍互降，一天最多掉 1.3 档
const ENG_NEGLECT = 0.6;    // 主动消息晾着 2h 没人理，掉这一刀（每条只掉一次）
const NEGLECT_MS = 2 * 3600000;
const AWAY_FACTOR = 0.5;

// ── 小型状态存取（坏数据一律重新开册） ──
function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === "object" ? v : fallback;
  } catch { return fallback; }
}
function writeJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── engagement（对外只给加减口）。数值别套对象版 readJson，它筛掉数字 ──
function engageOf(id) {
  try {
    const v = JSON.parse(localStorage.getItem(ENG_KEY + id));
    if (typeof v === "number" && v >= 0 && v <= 1) return v;
  } catch {}
  return ENG_DEFAULT;
}
export function engageBump(id, amount) {
  const e = Math.min(1, Math.max(0, engageOf(id) + amount));
  writeJson(ENG_KEY + id, e);
  return e;
}
// 用户开口 = 有人理了，晾着的那条就算结清了
export function noteUserTalk(id) {
  const rec = readJson(PRO_KEY + id, {});
  rec.counted = true;
  writeJson(PRO_KEY + id, rec);
}

// ── 配置清洗：windows [[9,24]] → 分钟区间 [[540,1440]] ──
function normWindows(w) {
  if (!Array.isArray(w)) return [];
  return w
    .map(([a, b]) => [Math.round(a * 60), Math.round(b * 60)])
    .filter(([a, b]) => b > a && a < 1440)
    .map(([a, b]) => [a, Math.min(1440, b)]);
}

function dayRec(id, dayStamp) {
  const rec = readJson(PRO_KEY + id, {});
  if (rec.date !== dayStamp) { return { date: dayStamp, sent: 0, lastAt: 0, counted: true }; }
  // 时间戳超 32 位，别用 |0 截断；日预算这种小数才用得上截断
  return { date: dayStamp, sent: rec.sent | 0, lastAt: Number(rec.lastAt) || 0, counted: !!rec.counted };
}

function minutesLeft(windows, now) {
  const m = now.getHours() * 60 + now.getMinutes();
  return windows.reduce((s, [a, b]) => s + (m >= a && m < b ? b - m : 0), 0);
}

// 每分钟一撞：返回这一分钟真该开口的 persona 列表。
// 命中概率 = 剩余名额 / 开窗剩余分钟（全程撒匀，不是整点准发）。
export function proactiveTick(people, now = new Date()) {
  // 本地日界做天账本（窗口语义全是小时-of-day，别让 UTC 错位一天）
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const fires = [];
  for (const p of people || []) {
    const s = p?.proactive;
    if (!s || !p.id) continue; // Sam 这类不配 proactive 的：永不主动
    const st = statusOf(p, now);
    if (st === "offline") continue;

    let e = engageOf(p.id) * ENG_DECAY;
    writeJson(ENG_KEY + p.id, e);

    const ds = dayRec(p.id, day);
    // 晾着太久 → 掉 engagement，且只掉一次
    if (ds.lastAt && !ds.counted && now.getTime() - ds.lastAt > NEGLECT_MS) {
      e *= ENG_NEGLECT;
      writeJson(ENG_KEY + p.id, e);
      ds.counted = true;
      writeJson(PRO_KEY + p.id, ds);
    }

    const windows = normWindows(s.windows);
    const left = minutesLeft(windows, now);
    if (!left) continue;
    const [lo, hi] = Array.isArray(s.perDay) ? s.perDay : [1, 1];
    const span = Math.max(0, hi - lo);
    const target = Math.round(lo + e * span);
    const rem = target - ds.sent;
    if (rem <= 0) continue;

    const chance = Math.min(1, rem / left) * (st === "active" ? 1 : AWAY_FACTOR);
    if (Math.random() < chance) {
      ds.sent += 1;
      ds.lastAt = now.getTime();
      ds.counted = false;
      writeJson(PRO_KEY + p.id, ds);
      fires.push(p);
    }
  }
  return fires;
}
