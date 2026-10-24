// 回复节奏引擎：用户给某个 persona 发消息后要等多久才被回。
// 状态是概率状态机：hours 表只当「基调」，实际状态 80/15/5 在邻档漂移，
// 每两分钟重掷；事件盖过基调——被回后升 active 锁 glow 分钟，
// AI 回话落地后不久的追问走 warm 秒回（小概率走开一阵再回）。
// 档位语义（Teams 风）：
//   active  —— 手边没事手机在手：按各人 reply 分布抽秒数（spike/normal/skew）
//   away    —— 没盯手机但收得到提醒：×4，下限也随机化
//   busy    —— 真忙：抽中（BUSY_CHANCE）才回，×9；抽不中挂起，漂回 active 再回
//   offline —— 睡着了，不回；消息排队压到醒来（下一个基调非 offline 小时）
// 缺数据/表坏了就当 active 处理（base 区间兜底），宁可回快也不炸。

const FALLBACK = { base: [30, 180], burst: [0, 1], glow: 15 };
const FACTOR = { away: 4, busy: 9 };
const STATUS = ["active", "away", "busy", "offline"];
const BUSY_CHANCE = 0.35; // busy 收到消息抽中才回
const STALE = 120000;     // 状态每两分钟重掷一次，旧签过期
const WARM_LEAVE = 0.15;      // 话题正热时角色走开的概率
const WARM_AWAY = [45, 180];  // 走开多久（秒），回来再回

// 状态缓存：id -> { anchor, state, at, until? }
const live = new Map();
let viewerKey = "";
export function setViewerKey(key) { viewerKey = String(key || ""); live.clear(); }

// 基调 = hours 表本位（表坏降级 active）。
function isDayOff(p, date) {
  const d = date.getDay();
  if (d === 0 || d === 6) return true;
  const stamp = date.toISOString().slice(0, 10);
  return (p?.schedule?.holidays || []).includes(stamp);
}
function anchorOf(p, date) {
  const off = isDayOff(p, date);
  const h = off ? (p?.schedule?.hoursWeekend || p?.schedule?.hours) : p?.schedule?.hours;
  const s = Array.isArray(h) && h.length === 24 ? h[date.getHours()] : "active";
  return STATUS.includes(s) ? s : "active";
}

// 80/15/5 邻档漂移：基调自己 0.8；边上两档朝邻档 15、跨档 5；
// 夹在中间的 away 两侧各 0.1。offline 不漂。
const DRIFT = { active: [0.8, 0.2, 0], away: [0.1, 0.8, 0.1], busy: [0.05, 0.15, 0.8] };

function driftState(anchor, p, date) {
  const i = ["active", "away", "busy"].indexOf(anchor);
  if (i < 0) return anchor;
  const w = DRIFT[anchor];
  let r = 2166136261;
  for (const c of `${viewerKey}|${p?.id}|${Math.floor(+date / STALE)}`) r = Math.imul(r ^ c.charCodeAt(0), 16777619);
  r = (r >>> 0) / 4294967296;
  const chance = p?.schedule?.activeChance?.[anchor];
  if (chance != null) return r < chance ? "active" : (r - chance) / (1 - chance) < w[1] / (1 - w[0]) ? "away" : "busy";
  return ["active", "away", "busy"][r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2];
}

// 单一事实源：查当前状态。glow 未过期 → active；否则缓存新鲜用缓存，
// 签过期（含 glow 到点）或基调变了就重掷并记账。
function settle(p, date) {
  const now = +date;
  const rec = live.get(p?.id) || {};
  if (rec.until > now) return "active";
  const anchor = anchorOf(p, date);
  // at 只记重掷时刻，别刷成 now —— 否则状态永远「新鲜」，两分钟重掷形同虚设
  const fresh = rec.anchor === anchor && now - rec.at < STALE && !rec.until;
  const state = fresh ? rec.state : driftState(anchor, p, date);
  live.set(p?.id, { anchor, state, at: fresh ? rec.at : now });
  return state;
}

// 各人的回复分布（性格的一部分）：
//   spike  —— 尖峰厚尾（Leo）：大概率秒回，少数拖很久
//   normal —— 正态（Chole）：几乎都在 4-5 秒附近
//   skew   —— 右偏（Sam）：不怎么看手机，多数偏慢、长尾拖右
const SHAPE = {
  spike() { return Math.random() < 0.7 ? Math.random() * 2 : rollSec([8, 240]); },
  normal() {
    const u1 = 1 - Math.random(), u2 = Math.random();
    return Math.min(12, Math.max(0.5, 4.5 + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 1.2));
  },
  skew() { return rollSec([6, 300]); },
};

function sampleReply(p) {
  const fn = SHAPE[p?.schedule?.reply];
  return fn ? fn() : rollSec(params(p).base);
}

export function statusOf(p, date = new Date()) {
  return settle(p, date);
}

// 被回（开口回复）后短暂真在线：升 active 锁 glow 分钟（性格/职业参数），
// 用户停嘴到点后不另做转移，自然跌回基调漂移。
export function noteReply(p, date = new Date()) {
  live.set(p?.id, { anchor: anchorOf(p, date), state: "active", at: +date, until: +date + params(p).glow * 60000 });
}

// 对数均匀抽样：多数落在低端、少数拖很长 —— 比均匀分布更像人。
function rollSec([lo, hi]) {
  lo = Math.max(1, lo);
  return Math.exp(Math.log(lo) + Math.random() * Math.log(Math.max(lo, hi) / lo));
}

// 睡着 → 几点醒：找到下一个非 offline 小时，落地时间为整点后 1-12 分钟。
function secondsToWake(p, date) {
  const h = p.schedule.hours;
  const from = date.getHours();
  for (let step = 1; step <= 24; step++) {
    if (h[(from + step) % 24] !== "offline") {
      const wait = step * 60 - (date.getMinutes() + date.getSeconds() / 60);
      return (wait + 1 + Math.random() * 11) * 60;
    }
  }
  return 8 * 3600; // 整天都 offline 是配置错误，8 小时兜底
}

function params(p) {
  const s = p?.schedule || {};
  return {
    base: Array.isArray(s.base) ? s.base : FALLBACK.base,
    burst: Array.isArray(s.burst) ? s.burst : FALLBACK.burst,
    glow: s.glow > 0 ? s.glow : FALLBACK.glow,
  };
}

// burst: [回复完主动补一句的概率, 最多补几轮]。话痨度是性格数据的一部分。
export function burstOf(p) {
  const [chance, extra] = params(p).burst;
  return { chance: Math.min(1, Math.max(0, chance || 0)), extra: Math.max(0, Math.floor(extra) || 0) };
}

// 回复要等多久（秒）。warm = 话题正热（AI 刚回过话不久）：忽略基调秒回，
// 小概率「角色走开」等一阵再回。offline 等「到醒来」；busy 抽不中 → -1：
// 这轮不回，消息挂起，状态漂回 active 后由 live.js 的轮询接着安排。
export function nextReplyDelay(p, date = new Date(), warm = false) {
  const st = settle(p, date);
  if (st === "offline") return secondsToWake(p, date);
  if (st === "busy" && Math.random() > BUSY_CHANCE) return -1;
  if (warm) {
    // 话题正热也不秒回：照各人回复分布抽样，只是两连取小向左偏一点
    if (Math.random() >= WARM_LEAVE) return Math.min(sampleReply(p), sampleReply(p));
    const [lo, hi] = WARM_AWAY;
    return lo + Math.random() * (hi - lo);
  }
  const f = FACTOR[st] ?? 1;
  // away/busy 慢的是「没盯手机」，下限也随机化，别让回复卡在同一秒上
  return f > 1 ? Math.max(sampleReply(p), rollSec([5, 15])) * f : sampleReply(p);
}
