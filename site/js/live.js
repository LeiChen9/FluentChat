// 对话页：Unit 列表点一个 → 进独立聊天页，下面既能打字也能打电话。
// 连 Gemini Live：拿 token → 建 WebSocket → 发空格唤醒 AI。
// 音频双向：AI 声音在浏览器直接播（24kHz PCM16），麦克风分片上行（16kHz PCM16）。
// Worker 全程只签 token，不碰音频。

import { loadContacts } from "./personas.js";
import { statusOf, nextReplyDelay, burstOf } from "./rhythm.js";

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
  let wakeSent = false;
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

  // 回复节奏：我方消息先排队，按 persona 作息抽样延迟到点才真发
  let outQueue = [];     // 等待回复期间攒下的我方消息，到点一起发
  let replyTimer = 0;    // 到点发送的定时器
  let typingTimer = 0;   // 较长延迟里「临回前 5 秒」才摆 typing
  let burstArmed = 0;    // 本条回复起角色还能补几轮
  let burstTimer = 0;    // 补话定时器
  let statusTimer = 0;   // 状态栏 / 苏醒检查的轮询

  // 挂断后的复盘
  let reviewCard = null;
  let reviewText = null;
  let reviewBuf = "";
  let reviewArmedAt = 0;
  let reviewIdle = null;
  let reviewCap = null;

  // ── 聊天列表：persona 好友，一行一个（read 自 contacts 数据目录） ──
  loadContacts().then((people) => {
    const chatList = document.getElementById("chat-list");
    for (const p of people) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML =
        `<img class="row__av" src="${p.avatar}" alt="">` +
        `<span class="row__text"><b>${p.name}</b><i>${p.preview}</i></span>` +
        `<span class="row__time">${p.time}</span>`;
      btn.addEventListener("click", () => openChat(p));
      li.append(btn);
      chatList.append(li);
    }
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

  // 连上之前输入框和通话键都锁着，免得消息掉进黑洞
  function setReady(on) {
    ready = on;
    input.disabled = !on;
    callBtn.disabled = !on;
    sendBtn.disabled = !on || !input.value.trim();
    input.placeholder = on ? "Message…" : "Connecting…";
  }

  function addBubble(who, text) {
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
  function flushPending() {
    hideTyping();
    if (pendingMe) {
      addBubble("me", pendingMe);
      pushHist({ who: "me", text: pendingMe });
      pendingMe = "";
    }
    if (pendingAi) {
      addBubble("ai", pendingAi);
      pushHist({ who: "ai", text: pendingAi });
      pendingAi = "";
    }
  }

  // ── 回复节奏（rhythm.js）──
  // persona 像真人一样不秒回：发出后按作息抽样的延迟到点才真发给模型。
  // 等回复期间连发的消息进队，到点一起回；typing 只在临回前出现；睡着的人
  // 不回话，等他的「醒来小时」到了才开口。
  const STATUS_LABEL = { active: "Active", away: "Away", busy: "Busy", offline: "Offline" };

  // 顶栏默认文案 = persona 当前状态；typing / Connecting… 优先，不动它们。
  function showStatus() {
    if (!unit || !ready || typingEl) return;
    setChatState(STATUS_LABEL[statusOf(unit, new Date())]);
  }

  // 空格唤醒 = 角色开口。离线的人不接话：不 wake，留在状态轮里等他醒。
  function maybeWake() {
    if (!ready || wakeSent || mode !== "text") return;
    if (statusOf(unit, new Date()) === "offline") { setChatState("Offline"); return; }
    wakeSent = true;
    send({ realtimeInput: { text: " " } });
    showTyping();
  }

  // 按作息抽一个延迟到点才发；较长的干等期间顶栏显示状态而非 typing。
  function armReply() {
    if (!unit) return;
    const delay = nextReplyDelay(unit, new Date());
    replyTimer = setTimeout(fireReply, delay * 1000);
    if (delay > 5) {
      typingTimer = setTimeout(() => {
        typingTimer = 0;
        if (replyTimer) showTyping(); // 临回前 5 秒才像真人一样「正在输入」
      }, (delay - 5) * 1000);
    } else {
      showTyping();
    }
  }

  function fireReply() {
    replyTimer = 0;
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = 0; }
    const texts = outQueue;
    outQueue = [];
    if (!ws || !texts.length) { showStatus(); return; } // 线已断，积压作废
    burstArmed += burstOf(unit).extra; // 从这条回复起，话痨角色有概率接着说
    for (const t of texts) send({ realtimeInput: { text: t } });
    showTyping();
  }

  // 角色补话：回复落地后按「性格概率」隔几秒再送一个空格，让模型自己续一轮。
  function examBurst() {
    if (mode !== "text" || !unit || reviewCard || !burstArmed || burstTimer) return;
    if (Math.random() >= burstOf(unit).chance) { burstArmed = 0; return; }
    burstArmed--;
    burstTimer = setTimeout(() => {
      burstTimer = 0;
      if (!ready) return;
      send({ realtimeInput: { text: " " } });
      showTyping();
    }, 2000 + Math.random() * 6000);
  }

  // ── 历史（本地留存，下次打开还在） ──
  function loadHist(id) {
    try {
      const arr = JSON.parse(localStorage.getItem(HIST_KEY + id) || "[]");
      return Array.isArray(arr) ? arr.filter((h) => h && typeof h.text === "string") : [];
    } catch {
      return [];
    }
  }

  function pushHist(item) {
    if (!unit) return;
    hist.push(item);
    try {
      localStorage.setItem(HIST_KEY + unit.id, JSON.stringify(hist.slice(-HIST_MAX)));
    } catch {}
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
  function openChat(u) {
    if (unit === u && ws) { show?.(); return; }
    teardown();
    unit = u;

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
    setChatState("Connecting…");
    setReady(false);

    // 把上次的聊天记录摆回来（含复盘卡片），别每次都是白纸一张
    hist = loadHist(u.id);
    for (const item of hist) {
      if (item.kind === "review") addReviewCard(item.text, false);
      else addBubble(item.who === "me" ? "me" : "ai", item.text);
    }

    show?.();
    scrollDown(true);
    // 半分钟一轮：顶栏跟着作息变状态；睡着时不开场白，醒了再接话。
    if (!statusTimer) statusTimer = setInterval(() => { maybeWake(); showStatus(); }, 30000);
    connect();
  }

  // 离开对话页就整个拆掉：连接、麦克风、正在写的气泡、没跑完的复盘，全部清干净。
  // 历史另存在 localStorage 里，不跟着这里走 —— 下次打开同一 Unit 会重新渲染，
  // 而且签 token 时会带上，模型那边也有记忆。
  function teardown() {
    connectSeq++; // 让还在等 token 的 connect 作废
    if (reviewIdle) { clearTimeout(reviewIdle); reviewIdle = null; }
    if (reviewCap) { clearTimeout(reviewCap); reviewCap = null; }
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = 0; }
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = 0; }
    if (burstTimer) { clearTimeout(burstTimer); burstTimer = 0; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = 0; }
    outQueue = [];
    burstArmed = 0;
    stopMic();
    stopPlayback();
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    wakeSent = false;
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

    callBox.hidden = true;
    callSaid.textContent = "";
    for (const n of body.querySelectorAll(".msg, .review")) n.remove();
    setReady(false);
    setChatState("Connecting…");
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  async function connect() {
    const u = unit;
    if (!u) return;
    const seq = ++connectSeq;

    // 1. 换一次性 token。prompt 钉在 token 里，前端碰不到。
    let token;
    try {
      const res = await fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // history：把之前聊过的交给后端钉进 system instruction，
        // 模型接着上次聊，不再重头开场。
        body: JSON.stringify({ unit: u.id, history: packHist() }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      token = data.token;
    } catch (e) {
      // 等 token 这会儿用户可能已经退出/换了一个 Unit
      if (seq !== connectSeq || unit !== u) return;
      setChatState(`Can't connect: ${e.message}`);
      return;
    }
    if (seq !== connectSeq || unit !== u) return;

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
      setChatState("Connection error");
      setReady(false);
    };
    sock.onclose = () => { if (ws === sock) onClose(u); };
  }

  function onClose(u) {
    if (unit !== u) return;
    stopMic();
    stopPlayback();
    flushPending(); // 断线时攒着的话先落下来，别丢
    // 掉线 = 时间线也停：没到点的回复和补话全部作废
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = 0; }
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = 0; }
    if (burstTimer) { clearTimeout(burstTimer); burstTimer = 0; }
    outQueue = [];
    burstArmed = 0;
    ws = null;
    wakeSent = false;
    setReady(false);
    if (reviewCard) finishReview();

    const wasCall = mode === "call";
    mode = "text";
    callBox.hidden = true;
    callSaid.textContent = "";
    setChatState(wasCall ? "Call dropped" : "Offline");
  }

  // ── 收消息 ──
  async function onMessage(e) {
    // 服务端可能在二进制帧里发 JSON，必须解出来
    const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
    if (!raw.trim().startsWith("{")) return; // 音频数据，下一步再处理

    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.error) { hideTyping(); setChatState(`出错：${d.error.message || d.error}`); return; }

    // setupComplete 后发一个空格唤醒 AI。Gemini 不会自己开口。
    // 醒来它先说本次话题的开场白，那就是聊天里的第一条消息。
    // 这期间不流式出字，先摆 typing，等整轮结束再落气泡。
    if (d.setupComplete) {
      setReady(true);
      maybeWake(); // 空格开口交给状态判断：睡着的人此刻不说话
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
      if (mode === "call") setCallState("On call");
    }
  }

  // ── 通话 ──
  function startCall() {
    if (!ready) return;
    ensureAudio(); // 必须在用户手势里同步调，手机才肯出声、才肯开麦克风
    mode = "call";
    callBox.hidden = false;
    callSaid.textContent = "";
    setCallState("On call");
    enableMic();
  }

  // 挂断：声音全停，然后把复盘当文字要回来。
  function hangUp() {
    stopMic();
    stopPlayback();
    callBox.hidden = true;
    callSaid.textContent = "";
    mode = "text";
    flushPending(); // 通话里说到一半的先落下来，别丢
    if (!ready) return;
    showStatus();
    // 缓 700ms：挂断瞬间可能还有一轮在飞，别把它的尾巴当成复盘内容
    setTimeout(() => {
      if (ready && mode === "text" && !reviewCard) requestReview();
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
  function resetChat() {
    const u = unit;
    if (!u) return;
    if (!confirm("Clear this chat? The history can't be recovered.")) return;
    teardown();
    try { localStorage.removeItem(HIST_KEY + u.id); } catch {}
    openChat(u); // unit 已被 teardown 置空，不会命中「同一个还开着」的早退分支
  }

  // ── 交互 ──
  backBtn.addEventListener("click", () => back?.());
  callBtn.addEventListener("click", startCall);
  callEnd.addEventListener("click", hangUp);
  resetBtn.addEventListener("click", resetChat);

  input.addEventListener("input", () => {
    sendBtn.disabled = !ready || !input.value.trim();
  });

  bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !ready) return;
    input.value = "";
    sendBtn.disabled = true;
    addBubble("me", text);
    pushHist({ who: "me", text });
    if (mode === "call") {
      send({ realtimeInput: { text } }); // 通话里打字不过节奏，照旧直发
      return;
    }
    outQueue.push(text);     // 文字模式：先排队，Personas 按作息到点才回
    if (replyTimer) return; // 已在等回复：排队等一起回，不清节奏
    armReply();
  });

  return {
    close: teardown,
    // 联系人页也从这里进对话
    open: openChat,
  };
}
