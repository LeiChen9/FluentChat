// 回复节奏引擎：用户给某个 persona 发消息后要等多久才被回。
// 状态从作息表查（schedule.json 的 hours，按用户本地时钟），
// 性格只改参数（base / burst）。档位语义（Teams 风）：
//   active  —— 手边没事，按基础区间回
//   away    —— 在忙别的但瞄得到消息，×3
//   busy    —— 真忙，×9（多半要等很久）
//   offline —— 睡着了，不回；消息排队压到醒来（下一个非 offline 小时）
// 缺数据/表坏了就当 active 处理，宁可回快也不炸。

const FALLBACK = { base: [30, 180], burst: [0, 1] };
const FACTOR = { active: 1, away: 3, busy: 9 };
const STATUS = ["active", "away", "busy", "offline"];

// 读状态。表必须是 24 格且取值合法，否则降级为 active。
export function statusOf(p, date = new Date()) {
  const h = p?.schedule?.hours;
  const s = Array.isArray(h) && h.length === 24 ? h[date.getHours()] : "active";
  return STATUS.includes(s) ? s : "active";
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
  };
}

// burst: [回复完主动补一句的概率, 最多补几轮]。话痨度是性格数据的一部分。
export function burstOf(p) {
  const [chance, extra] = params(p).burst;
  return { chance: Math.min(1, Math.max(0, chance || 0)), extra: Math.max(0, Math.floor(extra) || 0) };
}

// 回复要等多久（秒）。offline 时不是"很久"，是"到醒来"。
export function nextReplyDelay(p, date = new Date()) {
  const st = statusOf(p, date);
  if (st === "offline") return secondsToWake(p, date);
  const [lo, hi] = params(p).base;
  const f = FACTOR[st] ?? 1;
  return rollSec([lo * f, hi * f]);
}
