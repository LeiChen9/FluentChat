// 回复节奏引擎：用户给某个 persona 发消息后要等多久才被回。
// 状态是概率状态机：hours 表只当「基调」，实际状态 80/15/5 在邻档漂移，
// 每两分钟重掷；事件盖过基调——被回后升 active 锁 glow 分钟。
// 档位语义（Teams 风）：
//   active  —— 手边没事手机在手：按基础区间回
//   away    —— 没盯手机但收得到提醒：×4
//   busy    —— 真忙：抽中（BUSY_CHANCE）才回，×9；抽不中挂起，漂回 active 再回
//   offline —— 睡着了，不回；消息排队压到醒来（下一个基调非 offline 小时）
// 缺数据/表坏了就当 active 处理，宁可回快也不炸。

const FALLBACK = { base: [30, 180], burst: [0, 1], glow: 15 };
const FACTOR = { away: 4, busy: 9 };
const STATUS = ["active", "away", "busy", "offline"];
const BUSY_CHANCE = 0.35; // busy 收到消息抽中才回
const STALE = 120000;     // 状态每两分钟重掷一次，旧签过期

// 状态缓存：id -> { anchor, state, at, until? }
const live = new Map();

// 基调 = hours 表本位（表坏降级 active）。
function anchorOf(p, date) {
  const h = p?.schedule?.hours;
  const s = Array.isArray(h) && h.length === 24 ? h[date.getHours()] : "active";
  return STATUS.includes(s) ? s : "active";
}

// 80/15/5 邻档漂移：基调自己 0.8；边上两档朝邻档 15、跨档 5；
// 夹在中间的 away 两侧各 0.1。offline 不漂。
const DRIFT = { active: [0.8, 0.15, 0.05], away: [0.1, 0.8, 0.1], busy: [0.05, 0.15, 0.8] };

function driftState(anchor) {
  const i = ["active", "away", "busy"].indexOf(anchor);
  if (i < 0) return anchor;
  const w = DRIFT[anchor];
  const r = Math.random();
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
  const state = fresh ? rec.state : driftState(anchor);
  live.set(p?.id, { anchor, state, at: fresh ? rec.at : now });
  return state;
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

// 回复要等多久（秒）。offline 等「到醒来」；busy 抽不中 → -1：这轮不回，
// 消息挂起，状态漂回 active 后由 live.js 的轮询接着安排。
export function nextReplyDelay(p, date = new Date()) {
  const st = settle(p, date);
  if (st === "offline") return secondsToWake(p, date);
  if (st === "busy" && Math.random() > BUSY_CHANCE) return -1;
  const [lo, hi] = params(p).base;
  return rollSec([lo * (FACTOR[st] ?? 1), hi * (FACTOR[st] ?? 1)]);
}
