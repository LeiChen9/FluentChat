// 对话页：Unit 列表点一个 → 进独立聊天页，下面既能打字也能打电话。
// 连 Gemini Live：拿 token → 建 WebSocket → 发空格唤醒 AI。
// 音频双向：AI 声音在浏览器直接播（24kHz PCM16），麦克风分片上行（16kHz PCM16）。
// Worker 全程只签 token，不碰音频。

import { loadContacts } from "./personas.js";
import { statusOf, nextReplyDelay, burstOf, noteReply } from "./rhythm.js";
import { proactiveTick, engageBump, noteUserTalk } from "./proactive.js";

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
  "v1beta.GenerativeService.BidiGenerateContentConstrained";

// 音频采样率。Gemini Live 的硬性约定：输入 16kHz、输出 24kHz，都是单声道 PCM16。
const MIC_RATE = 16000;
const OUT_RATE = 24000;

// 挂断后发给 AI 的复盘指令。
// base.md 里复盘是「对话式点评、说完等用户反应」，这条是追在后面的用户输入，
// 把它掰成一次性交稿的中文文字：不分轮、不提问、直接给正文。
const REVIEW_REQ = [
  "通话结束了，现在把这次对话的复盘建议一次性给我。",
  "请直接用中文写成一整段交给我：不要分几轮，不要问我问题，也不要等我回应。",
  "这样组织：先用一两句话说清楚我这次做得好的一两个具体的地方；",
  "然后给 2-3 个我需要改的点，每个点一句中文说明，后面配一个我应该怎么说的简短英文例句；",
  "再说一句中文鼓励；",
  "最后附一份「表达清单」：把这次我说过的每一句（含语音转写）逐条整理，",
  "每条写「我说 X → 地道说法 Y」，中文点一下意思、英文给整句；已经地道的写这句已经很地道，",
  "没转写到的明说哪句没听清，不硬凑；只整理我说的话，不要贴你自己的话。",
  "现在就开始正文，不要寒暄，不要说「我们来复盘」这类开场，",
  "也不要做评分或语法长讲解。",
].join("");

// 转写分片的处理方式（实测修正）：
// 服务端给的不一定是「整轮完整文本」，旧代码按整轮覆盖写，
// 结果开场白只显示最后一片。现在分片先用 mergeChunk 合并攒着，
// 整轮结束（turnComplete）才一次性落成气泡 —— 不做流式逐字，
// 等待期间显示「正在输入…」气泡。

// 聊天历史持久化：每个 Unit 一份，存在浏览器 localStorage。
// 下次打开同一 Unit 把气泡渲染回来；签 token 时把记录一并交给后端，
// 钉进 system instruction —— 模型记得之前聊过，不再从开场白重来。
const HIST_KEY = "fluentchat:hist:v1:";
const HIST_MAX = 120;    // 本地每个 Unit 最多留多少条
const HIST_FOR_AI = 30;  // 交给模型最多多少条（每条再截 HIST_CHARS 字）
const HIST_CHARS = 400;

export function initChat({ show, back }) {
  // ── DOM ──
  const nameEl = document.getElementById("chat-name");
  const stateEl = document.getElementById("chat-state");
  const avEl = document.getElementById("chat-av");
  const avImg = avEl.querySelector("img");
  const body = document.getElementById("chat-body");
  const bar = document.getElementById("chat-bar");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const backBtn = document.getElementById("chat-back");
  const callBtn = document.getElementById("chat-call");
  const resetBtn = document.getElementById("chat-reset");

  const callBox = document.getElementById("call");
  const callAv = document.getElementById("call-av");
  const callAvImg = callAv.querySelector("img");
  const callName = document.getElementById("call-name");
  const callState = document.getElementById("call-state");
  const callSaid = document.getElementById("call-said");
  const callEnd = document.getElementById("call-end");

  // ── 会话状态 ──
  let ws = null;
  let connectSeq = 0;   // 每次建连/拆连自增，用来丢掉过期的异步 connect
  let unit = null;      // 当前打开的对话
  let ready = false;    // token + setup 都好了，可以收发
  let mode = "text";    // text = 只打字（不放声音）；call = 正在通话

  // 麦克风 / 播放
  let audioCtx = null;
  let micStream = null;
  let micSrc = null;
  let micProc = null;
  let micSink = null;
  let micActive = false;
  let micReady = false;
  let playHead = 0;
  let liveSources = [];

  // 本轮攒着还没落盘的话（不做流式，turnComplete 时一次性落成气泡）
  let pendingAi = "";
  let pendingMe = "";
  let typingEl = null;   // 「正在输入…」气泡
  let hist = [];         // 当前 Unit 的历史（内存 + localStorage 双写）

  // 回复节奏：状态挂在 persona 上（replies），切走聊天页也不打断。
  const replies = new Map(); // persona.id -> { texts, delay, gen, retry, ready, text, wait, used, req }
  let burstArmed = 0;    // 本条回复起角色还能补几轮
  let burstTimer = 0;    // 补话定时器
  let statusTimer = 0;   // 状态栏 / 苏醒检查的轮询
  let lastAiAt = 0;      // AI 上一轮回话落地的时刻；之后不久的追问 = 话题正热

  // 挂断后的复盘
  let reviewCard = null;
  let reviewText = null;
  let reviewBuf = "";
  let reviewArmedAt = 0;
  let reviewIdle = null;
  let reviewCap = null;

  // 列表预览跟最近一条消息走（不论谁说的，像 LINE），自己的话加 "You: " 前缀
  const clip = (text) => (text.length > 48 ? text.slice(0, 48) + "…" : text);
  // Gemini 偶吐占位符（<no speech> / {pause} …，音频停顿的转写脚注），别当台词
  const JUNK = /(?:<no\s*speech>|<silence>|<pause>|\{\s*pause\s*\}|\{\s*beat\s*\}|\{\s*hesitate\s*\}|\{\s*long\s*pause\s*\})/gi;
  const clean = (text) => String(text).replace(JUNK, " ").replace(/\s+/g, " ").trim();
  const lastLine = (id) => {
    const talk = loadHist(id).filter((h) => h.who === "me" || h.who === "ai");
    const last = talk[talk.length - 1];
    return last ? clip((last.who === "me" ? "You: " : "") + last.text) : null;
  };
  // 列表时间戳：当天显示时间，昨天 Yesterday，一周内周几，更早显示日期（Nov 15th）
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  function fmtRowTime(ts) {
    const d = new Date(ts), now = new Date();
    const gap = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
      - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (gap === 0) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (gap === 1) return "Yesterday";
    if (gap > 0 && gap < 7) return DAYS[d.getDay()];
    const n = d.getDate();
    const suf = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `${MONTHS[d.getMonth()]} ${n}${suf}`;
  }

  // ── 聊天列表：persona 好友，一行一个（read 自 contacts 数据目录） ──
  const rowOf = new Map(); // persona.id -> { li, preview, time } 列表行，有新消息要置顶
  // 有新消息（无论谁说的）就把这行的 li 挪到列表最上面，微信式
  function bumpRow(id) {
    const row = rowOf.get(id);
    if (row) row.li.parentNode.prepend(row.li);
  }
  let people = [];
  // 未读计数（内存）：后台落盘的消息条数，进对应对话清零。刷新即清空
  const unread = new Map();
  // 各行总数顺带落在底部 Chats 图标上（微信式）
  const tabBadge = document.querySelector('.tab[data-view="chats"]')
    ?.appendChild(Object.assign(document.createElement("i"), { className: "tab__badge", hidden: true }));
  function setBadge(id) {
    const row = rowOf.get(id);
    if (row) {
      const n = unread.get(id) || 0;
      row.badge.hidden = !n;
      row.badge.textContent = n;
    }
    let total = 0;
    for (const n of unread.values()) total += n;
    if (tabBadge) { tabBadge.hidden = !total; tabBadge.textContent = total; }
  }
  // 状态随时段漂移，列表行的名字点每分钟跟着 rhythm 刷一次
  function paintDots() {
    const now = new Date();
    for (const p of people) {
      const row = rowOf.get(p.id);
      if (row) row.dot.className = `dot dot--${statusOf(p, now)}`;
    }
  }
  loadContacts().then((list) => {
    people = list;
    const chatList = document.getElementById("chat-list");
    for (const p of people) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML =
        `<span class="row__avwrap"><img class="row__av" src="${p.avatar}" alt=""><i class="row__badge" hidden></i></span>` +
        `<span class="row__text"><b class="row__name">${p.name}<span class="dot"></span></b><i></i></span>` +
        `<span class="row__time">${p.time}</span>`;
      btn.addEventListener("click", () => openChat(p));
      li.append(btn);
      chatList.append(li);
      rowOf.set(p.id, {
        li: li,
        preview: btn.querySelector(".row__text i"),
        time: btn.querySelector(".row__time"),
        dot: btn.querySelector(".row__name .dot"),
        badge: btn.querySelector(".row__badge"),
      });
      rowOf.get(p.id).preview.textContent = lastLine(p.id) || "";
      const lastTalk = loadHist(p.id).filter((h) => h.who === "me" || h.who === "ai").at(-1);
      rowOf.get(p.id).time.textContent = lastTalk && lastTalk.t ? fmtRowTime(lastTalk.t) : p.time;
    }
    paintDots();
    startProactive(); // 名单到齐才开始调度
  });

  // ── 界面小工具 ──
  function scrollDown(force) {
    const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (!force && gap > 160) return; // 用户自己翻上去看历史，别硬拽回来
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }

  function setChatState(text) {
    stateEl.textContent = text;
  }

  function setCallState(text) {
    callState.textContent = text;
  }

  // ready 只表达「通话线就绪」：文本聊天走 /chat 不依赖线，输入永远可用
  function setReady(on) {
    ready = on;
    callBtn.disabled = on; // 通话里别再拨
  }

  // ── 时间分割线（微信式）── 上一条带 t 的消息距今 ≥5 分钟或换了天，
  // 就在气泡前插一条居中时间戳。t 缺省按发送时刻；旧历史没 t 就不插线。
  let lastStamp = null;
  const TIME_GAP = 5 * 60_000;

  function addBubble(who, text, t) {
    // 语义区分：不传 t = 此刻发出；显式 null = 历史里的旧条目（无 t 可依，
    // 沿用上一条的时间基线，不插线）。
    if (t === undefined) t = Date.now();
    if (t != null) {
      if (lastStamp == null || t - lastStamp >= TIME_GAP
          || new Date(t).toDateString() !== new Date(lastStamp).toDateString()) {
        const cur = new Date(t), prev = new Date(lastStamp ?? t);
        const stamp = document.createElement("p");
        stamp.className = "msg msg--time";
        const fmt = lastStamp != null && cur.toDateString() === prev.toDateString()
          ? { hour: "2-digit", minute: "2-digit", hour12: false }
          : { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
        stamp.textContent = cur.toLocaleString("zh-CN", fmt);
        body.append(stamp);
      }
      lastStamp = t;
    }
    const node = document.createElement("p");
    node.className = `msg msg--${who}`;
    node.textContent = text;
    body.append(node);
    scrollDown(true);
    return node;
  }

  // ── typing 提示 ──
  // AI 的回复不逐字流式出字：分片先攒着，等整轮结束一次性落气泡，
  // 这期间摆一个「正在输入…」气泡，和微信/WhatsApp 一样。
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("p");
    typingEl.className = "msg msg--ai msg--typing";
    typingEl.innerHTML = "<i></i><i></i><i></i>";
    body.append(typingEl);
    scrollDown(true);
    setChatState("typing…");
  }

  function hideTyping() {
    if (!typingEl) return;
    typingEl.remove();
    typingEl = null;
  }

  // 转写分片合并。开场白「只显示最后一段」的根因：服务端给的是增量分片，
  // 旧代码整轮覆盖写，只剩最后一片。这里按内容猜服务端语义：
  // 新包含旧文 → 整轮累计（覆盖）；旧文含新包 → 重复（丢）；否则 → 增量（拼）。
  function mergeChunk(buf, line) {
    if (!buf) return line;
    if (line.includes(buf)) return line;
    if (buf.includes(line)) return buf;
    return buf + line;
  }

  // 本轮攒下的话一次性落成气泡，并写进本地历史。
  // 长回复拆条：再「一次把话讲完」的人也不发一坨长文 —— 按句子分堆，
  // 每堆 ≤ MAX_BUBBLE，第一段立落，后面的间隔 1.2-3 秒配 typing 逐段出。
  const MAX_BUBBLE = 160;
  function sliceReply(text) {
    if (text.length <= MAX_BUBBLE) return [text];
    const parts = text.match(/[^.!?…。！？]+[.!?…。！？]*/g) || [text];
    const out = [];
    let heap = "";
    for (const s of parts) {
      if (heap && (heap + s).length > MAX_BUBBLE) { out.push(heap.trim()); heap = ""; }
      heap += s;
    }
    if (heap.trim()) out.push(heap.trim());
    return out;
  }

  function flushPending() {
    hideTyping();
    if (pendingMe) {
      const text = clean(pendingMe);
      pendingMe = "";
      if (text) { addBubble("me", text); pushHist({ who: "me", text, t: Date.now() }); }
    }
    if (pendingAi) {
      const parts = sliceReply(pendingAi).map((t) => clean(t)).filter((t) => t);
      pendingAi = "";
      if (!parts.length) return;
      lastAiAt = Date.now(); // 回话落地 = 参照点：紧随的追问按「话题正热」处理
      if (parts.length === 1) { addBubble("ai", parts[0]); pushHist({ who: "ai", text: parts[0], t: Date.now() }); return; }
      let i = 0;
      const drip = () => {
        if (i >= parts.length) { hideTyping(); showStatus(); return; }
        if (i > 0) showTyping();
        setTimeout(() => {
          hideTyping();
          addBubble("ai", parts[i]);
          pushHist({ who: "ai", text: parts[i], t: Date.now() });
          i++;
          drip();
        }, i === 0 ? 0 : 1200 + Math.random() * 1800);
      };
      drip();
    }
  }

  // ── 回复节奏（rhythm.js）──
  // persona 像真人一样不秒回：发出后按作息抽样的延迟到点才真发给模型。
  // 等回复期间连发的消息进队，到点一起回；typing 只在临回前出现；睡着的人
  // 不回话，等他的「醒来小时」到了才开口。
  const STATUS_LABEL = { active: "Active", away: "Away", busy: "Busy", offline: "Offline" };
  const WARM_WINDOW = 90000; // AI 回话后多久内，用户再开口算话题正热 → 秒回

  // 顶栏默认文案 = persona 当前状态；typing / Connecting… 优先，不动它们。
  function showStatus() {
    if (!unit || typingEl) return;
    setChatState(STATUS_LABEL[statusOf(unit, new Date())]);
  }

  // 空格唤醒已取消：角色不主动开口，用户先说话。

  // 回复节奏（rhythm.js 的作息抽样 + 后台生成两条线并行）：
  // 消息一落 localStorage 立刻后台调 /chat 备好文案，作息抽样延迟到点、
  // 文案也就绪后，才按文案长度摆 typing（45ms/字，真人速度）并逐条落气泡。
  // 状态挂在 replies（persona 归属）：切走聊天页不打断，人不在就交后台落盘。
  const THINK_MS = 45;   // 打字速度：毫秒/字（100 字 ≈ 4.5 秒）
  const THINK_MIN = 1200;
  const THINK_MAX = 9000;

  function beginReply(u, directive) {
    let st = replies.get(u.id);
    if (st) return st;
    st = { texts: [], delay: 0, gen: null, retry: 0, ready: false, text: "", wait: 0, used: 0, req: directive || "" };
    replies.set(u.id, st);
    scheduleDelay(u, st);
    queueMicrotask(() => startGen(u, st)); // 留一拍：同栈里先把本条话计入，used 才锁得住带了几条
    return st;
  }

  function scheduleDelay(u, st) {
    if (st.delay) return;
    const warm = Date.now() - lastAiAt < WARM_WINDOW;
    const delay = nextReplyDelay(u, new Date(), warm);
    if (delay < 0) { // busy 抽不中：挂起，每分钟看一眼状态，漂回 active 再续
      st.delay = setTimeout(() => { st.delay = 0; scheduleDelay(u, st); }, 60000);
      return;
    }
    if (delay > 0) st.delay = setTimeout(() => { st.delay = 0; proceedReply(u); }, delay * 1000);
    proceedReply(u); // delay=0（话题正热秒回）：文案就绪就立刻进 typing
  }

  function startGen(u, st) {
    if (st.gen || st.ready) return;
    st.used = st.texts.length; // 这次生成带上的是几条发言（packFor 读 localStorage）
    st.gen = genChat(u, st.req).then((text) => {
      st.gen = null; st.text = text; st.ready = true;
      if (!st.delay && !st.wait) proceedReply(u);
    }, () => { // 生成失败不当场放弃：队列还在，缓 8-30 秒按原节奏重试
      st.gen = null;
      st.retry = setTimeout(() => { st.retry = 0; startGen(u, st); }, 8000 + Math.random() * 22000);
    });
  }

  // 两个前置（延迟到点 + 文案就绪）都过完才进 typing；通话里不回话，挂断再续
  function proceedReply(u) {
    const st = replies.get(u.id);
    if (!st || st.delay || st.gen || st.retry || !st.ready) return;
    if (unit === u && mode === "call") {
      st.delay = setTimeout(() => { st.delay = 0; proceedReply(u); }, 60000);
      return;
    }
    noteReply(u, new Date()); // 张嘴回话 = 短暂真在线，升 active 锁 glow 分钟
    if (unit === u && mode === "text" && !reviewCard) {
      showTyping();
      const ms = Math.min(Math.max(st.text.length * THINK_MS, THINK_MIN), THINK_MAX);
      st.wait = setTimeout(() => { st.wait = 0; deliverReply(u, st); }, ms);
    } else {
      deliverReply(u, st); // 人已经不在：后台直接落盘
    }
  }

  // 文案就绪落气泡：开着本对话按节奏逐条出（多条间再摆 typing），没开着走后台路径
  function deliverReply(u, st) {
    const text = clean(st.text);
    replies.delete(u.id);
    if (!text) return;
    if (unit !== u || mode !== "text" || reviewCard) { deliverProactive(u, text); return; }
    lastAiAt = Date.now(); // 回话落地 = 话题正热的参照点
    if (st.req !== BURST_REQ) burstArmed += burstOf(u).extra; // 补话的回话别给自己续弹药
    const parts = sliceReply(text).filter(Boolean);
    let i = 0;
    const drip = () => {
      if (i >= parts.length) {
        hideTyping(); showStatus();
        // 生成期间用户又开了口：剩下的照常流程再回一轮（话没丢，话题正热秒回）
        const extra = st.texts.length - st.used;
        if (extra > 0) { const st2 = beginReply(u); for (let k = 0; k < extra; k++) st2.texts.push(""); }
        examBurst(u);
        return;
      }
      if (i > 0) showTyping();
      setTimeout(() => {
        if (unit !== u || mode !== "text") { // 到点前又换了人：剩余的走后台落盘
          for (; i < parts.length; i++) deliverProactive(u, parts[i]);
          return;
        }
        hideTyping();
        addBubble("ai", parts[i]);
        pushHist({ who: "ai", text: parts[i], t: Date.now() });
        i++;
        drip();
      }, i === 0 ? 0 : 1200 + Math.random() * 1800);
    };
    drip();
  }

  // 拆掉某人的在途回复（Reset 清历史时用）：定时器全清，状态退场
  function cancelReply(u) {
    const st = replies.get(u.id);
    if (!st) return;
    replies.delete(u.id);
    for (const t of [st.delay, st.retry, st.wait]) if (t) clearTimeout(t);
  }

  // 角色补话：回复落地后按「性格概率」隔几秒再跟一条，让模型自己续一轮。
  function examBurst(u) {
    if (!u || !burstArmed || burstTimer) return;
    if (Math.random() >= burstOf(u).chance) { burstArmed = 0; return; }
    burstArmed--;
    burstTimer = setTimeout(() => {
      burstTimer = 0;
      if (statusOf(u, new Date()) === "offline") return; // 睡着的人不补话
      if (unit === u && mode !== "text") return; // 就在这页还打着电话：别 texting 抢戏
      beginReply(u, BURST_REQ); // 走同一套节奏机：延迟 + 后台生成，切走照样落盘
      noteReply(u, new Date()); // 想开口先升 active：状态和消息保持一致
    }, 2000 + Math.random() * 6000);
  }

  // ── 主动消息（proactive.js 调度，内容走 /chat 无流式链路） ──
  // persona 没等到用户说话也能自己开口：频率/时段在 contact.json，
  // 冷热由 engagement 调；offline 永不主动，away/busy 概率减半——
  // 真开口那一刻先 noteReply 升 active，状态和动作保持一致。
  const PRO_MINUTE = 60000;
  const PRO_REQ =
    "(Proactive turn. Nobody spoke just now: text me first like a friend would. " +
    "Pick up whatever we talked about recently or something happening in your day " +
    "right now. 1-2 short casual sentences. Not a meta-greeting, don't mention " +
    "that you haven't heard from me.)";
  const PRO_RETRY_MS = 90000; // 生成失败缓 1.5 分钟再试，一次为限
  const BURST_REQ =
    "(Follow-up turn: you just texted and, like a real friend, you want to add one " +
    "quick thing. 1-2 short casual lines. Don't start a big new topic.)";

  let proTimer = 0;
  const proFail = new Map(); // persona.id -> 剩余重试（避开每日名额浪费）

  function startProactive() {
    if (proTimer) return;
    proTimer = setInterval(() => {
      paintDots();
      for (const p of proactiveTick(people, new Date())) fireProactive(p);
    }, PRO_MINUTE);
  }

  async function fireProactive(p, retried) {
    if (unit === p) {
      // 就在这个对话页：回复已在途（在生成/在等）时别抢话
      if (mode !== "text" || replies.has(p.id)) return;
    }
    noteReply(p, new Date()); // 想开口先升 active
    const text = clean(await genProactive(p, retried));
    if (!text) return;
    deliverProactive(p, text);
  }

  // 一发 /chat：本地历史（含刚排队的话）+ 可选指令，模型容灾链给整段回复
  async function genChat(p, directive) {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: p.id,
        history: packFor(p),
        directive: directive || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.content) throw new Error(data.error || `HTTP ${res.status}`);
    const text = clean(data.content);
    if (!text) throw new Error("blank reply");
    return text;
  }

  async function genProactive(p, retried) {
    try {
      const text = await genChat(p, PRO_REQ);
      proFail.delete(p.id);
      return text;
    } catch (e) {
      console.warn("proactive:", e);
      if (!retried) proFail.set(p.id, setTimeout(() => {
        proFail.delete(p.id);
        fireProactive(p, true); // 只重试一次：成了就没浪费每日名额
      }, PRO_RETRY_MS));
      return "";
    }
  }

  // 给模型的近况：开着本对话用现成的 packHist；没开着从本地历史里切。
  function packFor(p) {
    if (unit === p) return packHist();
    return loadHist(p.id).filter((h) => h.who === "me" || h.who === "ai")
      .slice(-HIST_FOR_AI)
      .map((h) => ({ who: h.who, text: String(h.text).slice(0, HIST_CHARS) }));
  }

  // 落地：开着本对话就在页里出气泡进记忆；没开着只落盘 + 刷列表预览。
  function deliverProactive(p, text) {
    if (unit === p && mode === "text" && !reviewCard) {
      noteReply(p, new Date()); // 正式开口，再锁一次 glow
      const parts = sliceReply(text);
      for (const t of parts) { addBubble("ai", t); pushHist({ who: "ai", text: t, t: Date.now() }); }
      lastAiAt = Date.now(); // 用户马上接话 = 话题正热的参照点
      return;
    }
    // 对话页没开：写进本地历史，回页时自然渲染；列表预览提个醒+置顶
    const arr = loadHist(p.id);
    arr.push({ who: "ai", text, t: Date.now() });
    const KEEP = arr.slice(-HIST_MAX);
    try { localStorage.setItem(HIST_KEY + p.id, JSON.stringify(KEEP)); } catch {}
    mirrorHist(p.id);
    bumpRow(p.id);
    const row = rowOf.get(p.id);
    if (row) {
      row.preview.textContent = clip(text);
      row.time.textContent = fmtRowTime(Date.now());
    }
    // 没看着的消息就是未读
    unread.set(p.id, (unread.get(p.id) || 0) + 1);
    setBadge(p.id);
  }

  // ── 历史（本地留存，下次打开还在） ──
  function loadHist(id) {
    try {
      const arr = JSON.parse(localStorage.getItem(HIST_KEY + id) || "[]");
      if (!Array.isArray(arr)) return [];
      // 旧缓存里存过占位符和整行空白，读进来顺手清一遍（预览/渲染/给模型的记忆都干净）
      return arr
        .filter((h) => h && typeof h.text === "string")
        .map((h) => (h.who ? { ...h, text: clean(h.text) } : h))
        .filter((h) => h.who ? h.text : true);
    } catch {
      return [];
    }
  }

  // R2 镜像：本地一落盘就顺手 PUT（fire-and-forget）。云端是耐久备份——
  // 换设备/清缓存能接回来，后续 cron 云端主动推送也从这儿读
  function mirrorHist(id) {
    return fetch(`/hist/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loadHist(id).slice(-HIST_MAX)),
    }).catch(() => {});
  }

  function pushHist(item) {
    if (!unit) return;
    item.t = Date.now();
    hist.push(item);
    const KEEP = hist.slice(-HIST_MAX);
    try {
      localStorage.setItem(HIST_KEY + unit.id, JSON.stringify(KEEP));
    } catch {}
    mirrorHist(unit.id);
    // 落一条预览跟着动，回列表就能看到最新一条（像 WhatsApp/LINE）
    bumpRow(unit.id); // 谁有新消息就置顶（微信式），自己发的也算
    const row = rowOf.get(unit.id);
    if (row) {
      row.preview.textContent = clip((item.who === "me" ? "You: " : "") + item.text);
      row.time.textContent = fmtRowTime(item.t);
    }
  }

  // 交给后端钉进 system instruction 的那份：只要真正的对话。
  // 复盘卡片是模型产出的总结，不算对话轮次，别混进去。
  function packHist() {
    return hist
      .filter((h) => h.who === "me" || h.who === "ai")
      .slice(-HIST_FOR_AI)
      .map((h) => ({ who: h.who, text: String(h.text).slice(0, HIST_CHARS) }));
  }

  // 出错时显示在界面上，别只 console.warn（手机上看不到 console）
  function noteError(text) {
    if (mode === "call") callSaid.textContent = text;
    else setChatState(text);
  }

  // ── AudioContext ──
  // 建/唤醒必须在用户手势里同步调一次，否则 iOS/Chrome 会把它停在 suspended，
  // 麦克风和播放一起哑掉。纯文字聊天根本不用碰它。
  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function stopPlayback() {
    for (const src of liveSources) {
      try { src.stop(); } catch {}
    }
    liveSources = [];
    if (audioCtx) playHead = audioCtx.currentTime;
  }

  // Gemini 的音频是 base64 包着的裸 PCM16（24kHz 单声道），没有文件头，
  // decodeAudioData 解不了它（promise 直接 reject，而且原来被 .catch 吞掉，
  // 表现就是「有转写、没声音」）。必须自己按小端 int16 读出来转 Float32，
  // 塞进 AudioBuffer，再按 playHead 排队 start(at)，分片才不会重叠/断音。
  function playAudioBase64(b64) {
    if (!b64) return;
    stopRingback(); // AI 的第一声进来，彩铃到此为止（对方「接了」）
    // 「On call」跟随人声时刻：彩铃在响、说话未到就不顶接通态
    if (mode === "call") setCallState("On call");
    try {
      const ctx = ensureAudio();
      const bin = atob(b64);
      const samples = bin.length >> 1; // PCM16 每样本 2 字节
      if (!samples) return;

      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);

      const buf = ctx.createBuffer(1, samples, OUT_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < samples; i++) {
        ch[i] = view.getInt16(i * 2, true) / 32768;
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(playHead, ctx.currentTime);
      src.start(at);
      playHead = at + buf.duration;
      liveSources.push(src);
      src.onended = () => {
        liveSources = liveSources.filter((s) => s !== src);
      };
    } catch (e) {
      noteError(`Playback failed: ${e.message}`);
    }
  }

  function base64FromUint8(arr) {
    let s = "";
    for (let i = 0; i < arr.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  // Float32 → PCM16 的小端字节流（Gemini 要 little-endian 16-bit）
  function float32ToPcm16Bytes(f32) {
    const out = new Uint8Array(f32.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      if (s > 1) s = 1;
      if (s < -1) s = -1;
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return out;
  }

  // 麦克风按设备原生采样率采（多半 48000），Gemini 输入要 16000。
  // 之前直接把设备数据标成 24000 发上去，等于变速播放给 AI 听，它听不懂。
  function downsample(f32, inRate, outRate) {
    if (outRate === inRate) return f32;
    const ratio = inRate / outRate;
    const outLen = Math.floor(f32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, f32.length - 1);
      const frac = pos - i0;
      out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
    }
    return out;
  }

  // ── 麦克风 ──
  async function startMic() {
    if (micActive || micReady) return;
    try {
      if (!navigator.mediaDevices) {
        throw new Error("Mic is blocked outside HTTPS, browsers won't allow it");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micStream = stream;

      const ctx = ensureAudio();
      micSrc = ctx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      micProc = ctx.createScriptProcessor(bufferSize, 1, 1);

      micProc.onaudioprocess = (e) => {
        if (!micActive || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        // 先降到 16k，再转 PCM16 小端；两处都对上 Gemini 的约定
        const pcm = float32ToPcm16Bytes(downsample(input, ctx.sampleRate, MIC_RATE));
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: base64FromUint8(pcm),
                mimeType: `audio/pcm;rate=${MIC_RATE}`,
              },
            },
          })
        );
      };

      // ScriptProcessor 必须接到 destination 才会被驱动，但直接接会把你的声音
      // 原样播出来（回声/啸叫）。中间串一个增益为 0 的节点：能跑，但不出声。
      micSink = ctx.createGain();
      micSink.gain.value = 0;
      micSink.connect(ctx.destination);

      micSrc.connect(micProc);
      micProc.connect(micSink);
      micReady = true;
    } catch (err) {
      console.warn("麦克风无法打开:", err);
      // 显示出来，别只在 console 里（手机上看不到 console）
      callSaid.textContent = `Mic unavailable: ${err.message}`;
    }
  }

  function stopMic() {
    micActive = false;
    if (micProc) {
      try { micProc.disconnect(); } catch {}
      micProc = null;
    }
    if (micSrc) {
      try { micSrc.disconnect(); } catch {}
      micSrc = null;
    }
    if (micSink) {
      try { micSink.disconnect(); } catch {}
      micSink = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    micReady = false;
  }

  function enableMic() {
    if (micReady) {
      micActive = true;
      return;
    }
    startMic().then(() => {
      if (micReady) micActive = true;
    });
  }

  // ── 打开 / 关掉一个对话 ──
  async function openChat(u) {
    if (unit === u) { show?.(); return; } // 同一个人：页面/连接/复盘都还热着，直接回去
    teardown();
    unit = u;
    unread.delete(u.id); // 进对话 = 看过了
    setBadge(u.id);

    // 头像直接用 persona 自己的照片，不再靠猫图染色
    avImg.src = u.avatar;
    avImg.style.removeProperty("--fx");
    avEl.style.removeProperty("--av");
    callAvImg.src = u.avatar;
    callAvImg.style.removeProperty("--fx");
    callAv.style.removeProperty("--av");

    nameEl.textContent = u.name;
    callName.textContent = u.name;
    callSaid.textContent = "";
    // 文本秒开：不握手，顶栏直接显示作息状态；线路只在拨电话那刻才建
    setChatState(STATUS_LABEL[statusOf(u, new Date())]);
    setReady(false);

    // 把上次的聊天记录摆回来（含复盘卡片），别每次都是白纸一张。
    // 本机有的话本地为准，但云端总得拉一面：离线代打（cron 写的 {
    // user}/hist 镜像）要合流回本地主档，所以改成永远合，而不是
    // 「本地空才补位」。按 who|text|t 去重，t 升序滑入本地（浏览器
    // sort 稳定，旧数据没 t 的按原位排在最前）。
    hist = loadHist(u.id);
    {
      // 云端镜像拉取：本地历史干净ピ仕事 devs 正常，但 iOS 主屏 app 冷启动
      // 首猜偶发挂（登录都成功了家的 fetch 也会 Load failed）——空档时再补
      // 一枪。镜像里多的写回本地，主人反正史不丢。
      const key = (i) => `${i.kind || "b"}|${i.who}|${i.text}|${i.t ?? ""}`;
      let arr = null;
      const pullMirror = async () => {
        try {
          const res = await fetch(`/hist/${u.id}`);
          if (!res.ok) return null;
          const data = await res.json();
          return Array.isArray(data) ? data : null;
        } catch { return null; }
      };
      arr = await pullMirror();
      if (!arr && !hist.length) { // 本地也空 = 冷启动首猜失败的高发场景，等半秒再拉
        await new Promise((r) => setTimeout(r, 400));
        if (u === unit) arr = await pullMirror();
      }
      if (arr && arr.length) {
        const seen = new Set(hist.map(key));
        const extra = arr.filter((c) => c && c.who && !seen.has(key(c)));
        if (extra.length) {
          hist = [...hist, ...extra].sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).slice(-HIST_MAX);
          try { localStorage.setItem(HIST_KEY + u.id, JSON.stringify(hist)); } catch {}
        }
      }
    }
    for (const item of hist) {
      if (item.kind === "review") addReviewCard(item.text, false);
      else addBubble(item.who === "me" ? "me" : "ai", item.text, item.t ?? null);
    }

    show?.();
    scrollDown(true);
    // 半分钟一轮：顶栏跟着作息变状态。角色不主动开口，首轮回话等用户先说话。
    if (!statusTimer) statusTimer = setInterval(showStatus, 30000);
  }

  // 离开对话页就整个拆掉：连接、麦克风、正在写的气泡、没跑完的复盘，全部清干净。
  // 历史另存在 localStorage 里，不跟着这里走 —— 下次打开同一 Unit 会重新渲染，
  // 而且签 token 时会带上，模型那边也有记忆。
  function teardown() {
    connectSeq++; // 让还在等 token 的 connect 作废
    if (reviewIdle) { clearTimeout(reviewIdle); reviewIdle = null; }
    if (reviewCap) { clearTimeout(reviewCap); reviewCap = null; }
    // 在途的回复不拆（replies 挂在 persona 上）：延迟/生成/typing 照常走完，
    // 人不在就交 deliverProactive 后台落盘 + 刷列表预览。
    if (statusTimer) { clearInterval(statusTimer); statusTimer = 0; }
    burstArmed = 0;
    stopMic();
    stopPlayback();
    stopRingback(); // 退出页面/换人时彩铃必须一起收
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    playHead = 0;

    unit = null;
    mode = "text";
    pendingAi = "";
    pendingMe = "";
    hideTyping();
    hist = [];
    reviewCard = null;
    reviewText = null;
    reviewBuf = "";
    lastStamp = null; // 新会话的时间线重新起算

    callBox.hidden = true;
    callSaid.textContent = "";
    for (const n of body.querySelectorAll(".msg, .review")) n.remove();
    setReady(false);
    setChatState("Connecting…");
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // 通话没成/当场作废：回到文本模式，顶栏说明原因
  function abortCall(u, msg) {
    if (u !== unit) return;
    stopMic();
    stopPlayback();
    stopRingback();
    mode = "text";
    callBox.hidden = true;
    callSaid.textContent = "";
    setChatState(msg);
  }

  async function connect() {
    const u = unit;
    if (!u) return;
    const seq = ++connectSeq;
    setChatState("Connecting…"); // 顶栏给拨号反馈；文案由具体失败路径覆盖

    // 1. 换一次性 token。prompt 钉在 token 里，前端碰不到。
    // 主屏 web app / 弱网首猜偶发「Load failed」，等半秒补一枪留个后路。
    let token;
    const grabToken = () => fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // history：把之前聊过的交给后端钉进 system instruction，
      // 模型接着上次聊，不再重头开场。
      body: JSON.stringify({ unit: u.id, history: packHist() }),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      return data.token;
    });
    try {
      try {
        token = await grabToken();
      } catch (e) {
        setChatState("Connecting… (retrying)"); // 让用户知道还在拨，不是死了
        await new Promise((r) => setTimeout(r, 500));
        if (seq !== connectSeq || unit !== u || mode !== "call") return;
        token = await grabToken();
      }
    } catch (e) {
      // 等 token 这会儿用户可能已经退出/换了一个 Unit
      if (seq !== connectSeq || unit !== u) return;
      // 影响面展示：Load failed 这类 TypeError 的根由（cause）/设备形态贴出来好排查
      const why = [e.message, e.name && e.name !== "Error" ? `(${e.name})` : "",
        e.cause ? `[${e.cause}]` : ""].filter(Boolean).join(" ");
      abortCall(u, `Can't start a call: ${why}`);
      return;
    }
    if (seq !== connectSeq || unit !== u || mode !== "call") return; // 等待期间已经挂掉就别再连线

    // 2. 直连 Gemini（音频不经过 Worker）
    // socket 单独留一份：退了又进同一个 Unit 会新建连接，旧连接迟到的
    // onclose / onmessage 不能把新连接的状态冲掉，所以都先认 socket 再认 unit。
    const sock = new WebSocket(`${WS_BASE}?access_token=${token}`);
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
      // 第一条消息必须带 setup
      sock.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live" } }));
    };
    sock.onmessage = (e) => { if (ws === sock) onMessage(e); };
    sock.onerror = () => {
      if (ws !== sock || unit !== u) return;
      abortCall(u, "Connection error");
    };
    sock.onclose = () => { if (ws === sock) onClose(u); };
  }

  // 线死了只影响通话那件事：文本聊天不靠线照常，复盘在飞就先收尾
  function onClose(u) {
    if (unit !== u) return;
    stopMic();
    stopPlayback();
    stopRingback();
    flushPending(); // 断线时攒着的话先落下来，别丢
    ws = null;
    const wasCall = mode === "call";
    mode = "text";
    callBox.hidden = true;
    callSaid.textContent = "";
    if (reviewCard) { finishReview(); return; }
    showStatus(); // 顶栏回到作息状态
    if (wasCall) setChatState("Call dropped");
    // 通话期间挂着的文本回复立刻续上：挂断回文本模式照常回话
    const st = replies.get(u.id);
    if (st && st.delay) { clearTimeout(st.delay); st.delay = 0; proceedReply(u); }
  }

  // ── 收消息 ──
  async function onMessage(e) {
    // 服务端可能在二进制帧里发 JSON，必须解出来
    const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
    if (!raw.trim().startsWith("{")) return; // 音频数据，下一步再处理

    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.error) {
      hideTyping();
      noteError(`出错：${d.error.message || d.error}`);
      return;
    }

    // 通话线就绪：响铃继续，「接通」等 AI 出声才升——通道成了但人还没说话
    // 时显示通道级文案，别顶成 On call 让人以为已在通话
    if (d.setupComplete) {
      setReady(true);
      if (mode === "call") setCallState("Connected — waiting…");
      return;
    }

    const sc = d.serverContent || {};

    // 你插话时模型会被打断，已排队的音频要立刻停，不然它会继续念下去。
    // 已经转写出来的部分也别丢，先落成气泡。
    if (sc.interrupted) { stopPlayback(); flushPending(); }

    // 你说的话。只有 token 开了 inputAudioTranscription 才会有（worker 里开了）。
    // 通话里的转写同样攒到 turnComplete 再落气泡。
    const mine = sc.inputTranscription?.text;
    if (mine) pendingMe = mergeChunk(pendingMe, mine);

    const line = sc.outputTranscription?.text;
    if (line) {
      if (reviewCard) {
        // 复盘这一轮：攒在卡片里，不流式写、不走普通气泡
        reviewBuf = mergeChunk(reviewBuf, line);
        armReviewIdle(3500);
      } else {
        pendingAi = mergeChunk(pendingAi, line);
        if (mode === "call") {
          callSaid.textContent = pendingAi; // 通话页保留实时字幕（跟着语音走）
        } else {
          showTyping();
        }
      }
    }

    // 只有通话才放声音。打字聊天时音频直接丢掉——纯文字聊天根本不用碰
    // AudioContext，也就没有「自动播放受限」这回事。
    if (mode === "call" && !reviewCard) {
      const turnParts = sc.modelTurn?.parts;
      if (turnParts && Array.isArray(turnParts)) {
        for (const p of turnParts) {
          if (p.inlineData && p.inlineData.data) playAudioBase64(p.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      // 本轮攒的话（包括挂断后迟到的尾巴）一次性落成气泡
      flushPending();
      if (reviewCard) {
        // 挂断瞬间上一轮可能还有一条 turnComplete 迟到，别让它把
        // 刚起头的复盘掐了：等 700ms，而且至少要攒到字。
        if (reviewBuf.trim() && Date.now() - reviewArmedAt > 700) finishReview();
        return;
      }
      showStatus();
      examBurst();
      // turn 收尾不冒充接通：On call 由 AI 真出声那一刻 top 带上
    }
  }

  // ── 通话 ──
  // ── 彩铃：拨下就响，AI 第一声（或挂断/断线/退出）即停 ──
  // loop 循环拨号音；volume 低一点别盖过人声。播放失败静默（旧设备 iOS
  // 手势时机不对时宁可无声也不把通话卡死）。
  let ringback = null;

  // 彩铃音频预取：开屏就在后台把音频备成本地 Blob，拨号那刻秒响。
  // 推迟 3 秒再拉：开屏的那波并行请求（列表/头像/云端合流）别被它挤。
  // 切片档：10 秒 HE-AAC 64k mono ≈ 86KB，靠 Audio.loop 循环兜完整回铃。
  let ringbackUrl = null;
  setTimeout(() => {
    fetch("assets/DialMusic.m4a")
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => { if (blob) ringbackUrl = URL.createObjectURL(blob); })
      .catch(() => {});
  }, 3000);

  function startRingback() {
    stopRingback(); // 连拨以防上一次的尾巴还在
    ringback = new Audio(ringbackUrl || "assets/DialMusic.m4a");
    ringback.loop = true;
    ringback.volume = 0.55;
    ringback.play().catch(() => {});
  }

  function stopRingback() {
    if (!ringback) return;
    ringback.pause();
    ringback.currentTime = 0;
    ringback = null;
  }

  function startCall() {
    if (!unit || mode !== "text" || ws) return;
    ensureAudio(); // 必须在用户手势里同步调，手机才肯出声、才肯开麦克风
    startRingback(); // 彩铃跟着手势走：不等握手、AI 开口前一直响
    mode = "call";
    callBox.hidden = false;
    callSaid.textContent = "";
    setCallState("Connecting…"); // 拨号即握手：setupComplete 之后才 On call
    enableMic();
    connect();
  }

  // 挂断：声音全停，然后把复盘当文字要回来。
  function hangUp() {
    stopMic();
    stopPlayback();
    stopRingback();
    callBox.hidden = true;
    callSaid.textContent = "";
    mode = "text";
    flushPending(); // 通话里说到一半的先落下来，别丢
    if (!ws) { showStatus(); return; } // 还没握上就挂了，没有复盘可要
    showStatus();
    // 缓 700ms：挂断瞬间可能还有一轮在飞，别把它的尾巴当成复盘内容
    setTimeout(() => {
      if (ws && mode === "text" && !reviewCard) requestReview();
    }, 700);
  }

  // 复盘走的是同一条 Live 连接——模型手里本来就有整段对话，
  // 不用另开接口，也不用把 transcript 传回去。
  function requestReview() {
    flushPending(); // 挂断后迟到的对话先落卡，再摆复盘卡片（保持先后顺序）
    const { card, textEl } = addReviewCard("Summarizing our chat…", true);

    reviewCard = card;
    reviewText = textEl;
    reviewBuf = "";
    reviewArmedAt = Date.now();

    send({ realtimeInput: { text: REVIEW_REQ } });
    armReviewIdle(3500);
    reviewCap = setTimeout(finishReview, 30000);
  }

  // 转写是一段段来的，3.5 秒没新字就认为这轮完了。
  function armReviewIdle(delay) {
    if (reviewIdle) clearTimeout(reviewIdle);
    reviewIdle = setTimeout(() => {
      if (reviewBuf.trim()) { finishReview(); return; }
      if (Date.now() - reviewArmedAt > 9000) { finishReview(); return; }
      armReviewIdle(3500); // 还一个字都没来，再等等（reviewCap 兜底）
    }, delay);
  }

  function finishReview() {
    if (!reviewCard) return;
    if (reviewIdle) { clearTimeout(reviewIdle); reviewIdle = null; }
    if (reviewCap) { clearTimeout(reviewCap); reviewCap = null; }
    reviewCard.classList.remove("is-loading");
    const text = reviewBuf.trim();
    reviewText.textContent = text || "No review this time — hang up once and try again.";
    if (text) pushHist({ kind: "review", text });
    reviewCard = null;
    reviewText = null;
    reviewBuf = "";
    hideTyping();
    scrollDown(true);
    // 复盘收完，通话线的使命结束：文本聊天不依赖线
    if (mode === "text" && ws) { try { ws.close(); } catch {} }
  }

  // 复盘卡片：loading 态挂「正在整理…」，收尾时一次性贴正文（不流式）。
  function addReviewCard(text, loading) {
    const card = document.createElement("div");
    card.className = loading ? "review is-loading" : "review";
    const label = document.createElement("p");
    label.className = "review__label";
    label.textContent = "Review notes";
    const t = document.createElement("p");
    t.className = "review__text";
    t.textContent = text;
    card.append(label, t);
    body.append(card);
    scrollDown(true);
    return { card, textEl: t };
  }

  // Reset：清掉这个 Unit 的本地历史并拆线重连 —— 界面和模型一起回到白纸。
  async function resetChat() {
    const u = unit;
    if (!u) return;
    if (!confirm("Clear this chat? The history can't be recovered.")) return;
    cancelReply(u); // 在途回复一起退场，别等清空后落进白纸
    teardown();
    try { localStorage.removeItem(HIST_KEY + u.id); } catch {}
    await mirrorHist(u.id); // 云端一起清成空表，不然重开会从镜像复活
    openChat(u); // unit 已被 teardown 置空，不会命中「同一个还开着」的早退分支
  }

  // ── 交互 ──
  backBtn.addEventListener("click", () => back?.());
  callBtn.addEventListener("click", startCall);
  callEnd.addEventListener("click", hangUp);
  resetBtn.addEventListener("click", resetChat);

  input.addEventListener("input", () => {
    sendBtn.disabled = !input.value.trim();
  });

  bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    addBubble("me", text);
    pushHist({ who: "me", text, t: Date.now() });
    // 交互反馈进调度：用户开口 = 有人理，engagement 回弹；晾着的那次结清
    engageBump(unit.id, Date.now() - lastAiAt < WARM_WINDOW ? 0.3 : 0.2);
    noteUserTalk(unit.id);
    if (mode === "call") {
      send({ realtimeInput: { text } }); // 通话里打字不过节奏，照旧直发
      return;
    }
    // 文字模式：话已 pushHist，立刻后台备料；作息延迟照走，到点文案也就绪才 typing
    beginReply(unit).texts.push("");
  });

  return {
    close: teardown,
    // 联系人页也从这里进对话
    open: openChat,
  };
}
