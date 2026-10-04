// 对话页：Unit 列表点一个 → 进独立聊天页，下面既能打字也能打电话。
// 连 Gemini Live：拿 token → 建 WebSocket → 发空格唤醒 AI。
// 音频双向：AI 声音在浏览器直接播（24kHz PCM16），麦克风分片上行（16kHz PCM16）。
// Worker 全程只签 token，不碰音频。

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
  "v1beta.GenerativeService.BidiGenerateContentConstrained";

// 音频采样率。Gemini Live 的硬性约定：输入 16kHz、输出 24kHz，都是单声道 PCM16。
const MIC_RATE = 16000;
const OUT_RATE = 24000;

// Unit 标题，和 prompts/unit-XX.md 的「话题」对应。
// msg 是列表里那一行字——像对方先开的口，列表才像个聊天列表。
const UNITS = [
  { id: "unit-01", title: "Introduce Yourself", msg: "想聊聊你自己吗？" },
  { id: "unit-02", title: "Your Day", msg: "今天过得怎么样？" },
  { id: "unit-03", title: "Food & Drinks", msg: "中午吃什么了呀" },
  { id: "unit-04", title: "Weekend Plans", msg: "这周末有什么安排？" },
  { id: "unit-05", title: "Where You Live", msg: "你现在住在哪里呀" },
  { id: "unit-06", title: "Free Time", msg: "平时下班都做什么呀" },
];

// 头像只用正常猫的毛色：奶油 / 橘 / 银渐层 / 棕虎斑 / 灰 / 深灰，没有粉也没有蓝。
// 图是抠好底的透明 PNG，底下垫一层毛色当背景，再用 filter 把奶油白的猫染过去。
const AVATARS = [
  ["#e8ddc8", "none"],                                          // 奶油
  ["#efc793", "sepia(.6) saturate(2) hue-rotate(-15deg)"],      // 橘猫
  ["#cbc7c0", "grayscale(.9) brightness(1.02)"],                // 银渐层
  ["#cdb187", "sepia(.85) saturate(1.8) brightness(.9)"],       // 棕虎斑
  ["#bdb9b1", "grayscale(.9) brightness(.76) contrast(1.05)"],  // 灰猫
  ["#d5d1c9", "grayscale(1) brightness(.6) contrast(1.2)"],     // 深灰 / 黑
];

// 挂断后发给 AI 的复盘指令。
// base.md 里复盘是「对话式点评、说完等用户反应」，这条是追在后面的用户输入，
// 把它掰成一次性交稿的中文文字：不分轮、不提问、直接给正文。
const REVIEW_REQ = [
  "通话结束了，现在把这次对话的复盘建议一次性给我。",
  "请直接用中文写成一整段交给我：不要分几轮，不要问我问题，也不要等我回应。",
  "这样组织：先用一两句话说清楚我这次做得好的一两个具体的地方；",
  "然后给 2-3 个我需要改的点，每个点一句中文说明，后面配一个我应该怎么说的简短英文例句；",
  "最后用一句中文鼓励收尾。",
  "现在就开始正文，不要寒暄，不要说「我们来复盘」这类开场，",
  "也不要输出文字稿、评分、语法讲解或单词表。",
].join("");

// 转写是整轮覆盖上来的（服务端每次给的是这一轮到目前为止的完整文本），
// 所以同一条气泡直接改文本，不能拼接。

export function initChat({ show, back }) {
  // ── DOM ──
  const list = document.getElementById("unit-list");
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

  // 正在写的气泡
  let aiBubble = null;
  let meBubble = null;

  // 挂断后的复盘
  let reviewCard = null;
  let reviewText = null;
  let reviewBuf = "";
  let reviewArmedAt = 0;
  let reviewIdle = null;
  let reviewCap = null;

  // ── 对话列表 ──
  for (const [i, u] of UNITS.entries()) {
    const [avBg, avFx] = AVATARS[i % AVATARS.length];
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit";
    btn.innerHTML =
      `<span class="avatar" style="--av:${avBg}">` +
      `<img src="assets/npc-cat.webp" alt="" style="--fx:${avFx}"></span>` +
      `<span class="unit__text"><b>${u.title}</b><i>${u.msg}</i></span>`;
    btn.addEventListener("click", () => openChat(u));
    li.append(btn);
    list.append(li);
  }

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
    input.placeholder = on ? "发消息…" : "连接中…";
  }

  function addBubble(who, text) {
    const node = document.createElement("p");
    node.className = `msg msg--${who}`;
    node.textContent = text;
    body.append(node);
    scrollDown(true);
    return node;
  }

  function upsert(node, who, text) {
    const live = node || addBubble(who, "");
    live.textContent = text;
    scrollDown();
    return live;
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
      noteError(`播放失败：${e.message}`);
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
        throw new Error("当前不是 HTTPS，浏览器不给用麦克风");
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
      callSaid.textContent = `麦克风打不开：${err.message}`;
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

    const [avBg, avFx] = AVATARS[UNITS.indexOf(u) % AVATARS.length];
    avEl.style.setProperty("--av", avBg);
    avImg.style.setProperty("--fx", avFx);
    callAv.style.setProperty("--av", avBg);
    callAvImg.style.setProperty("--fx", avFx);

    nameEl.textContent = u.title;
    callName.textContent = u.title;
    callSaid.textContent = "";
    setChatState("连接中…");
    setReady(false);

    show?.();
    connect();
  }

  // 离开对话页就整个拆掉：连接、麦克风、正在写的气泡、没跑完的复盘，全部清干净。
  // 所以对话历史不跨会话保留——重开会话模型也没了记忆，留着旧消息反而骗人。
  function teardown() {
    connectSeq++; // 让还在等 token 的 connect 作废
    if (reviewIdle) { clearTimeout(reviewIdle); reviewIdle = null; }
    if (reviewCap) { clearTimeout(reviewCap); reviewCap = null; }
    stopMic();
    stopPlayback();
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    wakeSent = false;
    playHead = 0;

    unit = null;
    mode = "text";
    aiBubble = null;
    meBubble = null;
    reviewCard = null;
    reviewText = null;
    reviewBuf = "";

    callBox.hidden = true;
    callSaid.textContent = "";
    for (const n of body.querySelectorAll(".msg, .review")) n.remove();
    setReady(false);
    setChatState("连接中…");
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
        body: JSON.stringify({ unit: u.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      token = data.token;
    } catch (e) {
      // 等 token 这会儿用户可能已经退出/换了一个 Unit
      if (seq !== connectSeq || unit !== u) return;
      setChatState(`连不上：${e.message}`);
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
      setChatState("连接出错");
      setReady(false);
    };
    sock.onclose = () => { if (ws === sock) onClose(u); };
  }

  function onClose(u) {
    if (unit !== u) return;
    stopMic();
    stopPlayback();
    ws = null;
    wakeSent = false;
    setReady(false);
    if (reviewCard) finishReview();

    const wasCall = mode === "call";
    mode = "text";
    callBox.hidden = true;
    callSaid.textContent = "";
    setChatState(wasCall ? "通话中断了" : "已断开");
  }

  // ── 收消息 ──
  async function onMessage(e) {
    // 服务端可能在二进制帧里发 JSON，必须解出来
    const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
    if (!raw.trim().startsWith("{")) return; // 音频数据，下一步再处理

    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.error) { setChatState(`出错：${d.error.message || d.error}`); return; }

    // setupComplete 后发一个空格唤醒 AI。Gemini 不会自己开口。
    // 醒来它先说本次话题的开场白，那就是聊天里的第一条消息。
    if (d.setupComplete && !wakeSent) {
      wakeSent = true;
      setReady(true);
      setChatState("在线");
      send({ realtimeInput: { text: " " } });
      return;
    }

    const sc = d.serverContent || {};

    // 你插话时模型会被打断，已排队的音频要立刻停，不然它会继续念下去
    if (sc.interrupted) { stopPlayback(); aiBubble = null; }

    // 你说的话。只有 token 开了 inputAudioTranscription 才会有（worker 里开了）。
    const mine = sc.inputTranscription?.text;
    if (mine) meBubble = upsert(meBubble, "me", mine);

    const line = sc.outputTranscription?.text;
    if (line) {
      if (reviewCard) {
        // 复盘这一轮：整段覆盖写进卡片，不走普通气泡
        reviewBuf = line;
        reviewCard.classList.remove("is-loading");
        reviewText.textContent = reviewBuf;
        armReviewIdle(3500);
        scrollDown();
      } else {
        if (!aiBubble) {
          setChatState("在线"); // 上面刚打的「对方正在输入…」该撤了
          if (meBubble) meBubble = null; // AI 开口，你那句就算说完了
        }
        aiBubble = upsert(aiBubble, "ai", line);
        if (mode === "call") callSaid.textContent = line;
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
      if (reviewCard) {
        // 挂断瞬间上一轮可能还有一条 turnComplete 迟到，别让它把
        // 刚起头的复盘掐了：等 700ms，而且至少要攒到字。
        if (reviewBuf.trim() && Date.now() - reviewArmedAt > 700) finishReview();
        return;
      }
      aiBubble = null;
      meBubble = null;
      setChatState("在线");
      if (mode === "call") setCallState("通话中");
    }
  }

  // ── 通话 ──
  function startCall() {
    if (!ready) return;
    ensureAudio(); // 必须在用户手势里同步调，手机才肯出声、才肯开麦克风
    mode = "call";
    callBox.hidden = false;
    callSaid.textContent = "";
    setCallState("通话中");
    enableMic();
  }

  // 挂断：声音全停，然后把复盘当文字要回来。
  function hangUp() {
    stopMic();
    stopPlayback();
    callBox.hidden = true;
    callSaid.textContent = "";
    mode = "text";
    aiBubble = null;
    meBubble = null;
    if (!ready) return;
    setChatState("在线");
    // 缓 700ms：挂断瞬间可能还有一轮在飞，别把它的尾巴当成复盘内容
    setTimeout(() => {
      if (ready && mode === "text" && !reviewCard) requestReview();
    }, 700);
  }

  // 复盘走的是同一条 Live 连接——模型手里本来就有整段对话，
  // 不用另开接口，也不用把 transcript 传回去。
  function requestReview() {
    const card = document.createElement("div");
    card.className = "review is-loading";
    const label = document.createElement("p");
    label.className = "review__label";
    label.textContent = "复盘建议";
    const text = document.createElement("p");
    text.className = "review__text";
    text.textContent = "正在整理刚才的对话…";
    card.append(label, text);
    body.append(card);
    scrollDown(true);

    reviewCard = card;
    reviewText = text;
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
    reviewText.textContent = text || "这次没拿到复盘，挂断一次再试试。";
    reviewCard = null;
    reviewText = null;
    reviewBuf = "";
    aiBubble = null;
    meBubble = null;
    scrollDown(true);
  }

  // ── 交互 ──
  backBtn.addEventListener("click", () => back?.());
  callBtn.addEventListener("click", startCall);
  callEnd.addEventListener("click", hangUp);

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
    send({ realtimeInput: { text } });
    setChatState("对方正在输入…");
  });

  return { close: teardown };
}
