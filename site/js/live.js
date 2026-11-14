// 对话页：消息由服务端时间线驱动，手机只负责发送与渲染。
// 发送 = POST /messages（服务端排期），打开/可见时轮询 /conversation，
// 已读 = POST /seen；通话仍是浏览器直连 Gemini Live，只把转写回传服务端。
// 音频双向：AI 声音在浏览器直接播（24kHz PCM16），麦克风分片上行（16kHz PCM16）。

import { loadContacts } from "./personas.js?v=20261114-5";
import { saveCall, fmtDur } from "./calls.js?v=20261114-6";

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
  "v1beta.GenerativeService.BidiGenerateContentConstrained";

const MIC_RATE = 16000;
const OUT_RATE = 24000;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
export function fmtRowTime(ts) {
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

const STATUS_LABEL = { active: "Active", away: "Away", busy: "Busy", offline: "Offline" };

export function initChat({ show, back, openCall, openClass }) {
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

  let ws = null;
  let connectSeq = 0;
  let unit = null;
  let ready = false;
  let mode = "text";

  let audioCtx = null;
  let micStream = null;
  let micSrc = null;
  let micProc = null;
  let micSink = null;
  let micActive = false;
  let micReady = false;
  let playHead = 0;
  let liveSources = [];

  let pendingAi = "";
  let pendingMe = "";
  let typingEl = null;
  let lastId = 0;
  let pollTimer = 0;
  let pollBusy = false;
  let openSeq = 0;
  const pendingNodes = new Map(); // client_id -> 乐观气泡 node
  const drawnIds = new Set();     // 已上屏的服务端消息 id

  let people = [];
  const statusMap = new Map(); // unit -> active/away/busy/offline
  const rowOf = new Map();
  let lastStamp = null;
  const TIME_GAP = 5 * 60_000;

  const clip = (text) => (text.length > 48 ? text.slice(0, 48) + "…" : text);
  const JUNK = /(?:<no\s*speech>|<silence>|<pause>|\{\s*pause\s*\}|\{\s*beat\s*\}|\{\s*hesitate\s*\}|\{\s*long\s*pause\s*\})/gi;
  const clean = (text) => String(text).replace(JUNK, " ").replace(/\s+/g, " ").trim();

  // ── 列表 ─────────────────────────────────────────────────────────────
  function sortRows() {
    const list = document.getElementById("chat-list");
    const rows = [...rowOf.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const row of rows) list.append(row.li);
  }

  const tabBadge = document.querySelector('.tab[data-view="chats"]')
    ?.appendChild(Object.assign(document.createElement("i"), { className: "tab__badge", hidden: true }));

  async function refresh() {
    const res = await fetch("/conversations");
    if (!res.ok) return;
    const data = await res.json();
    let total = 0;
    for (const c of data.conversations || []) {
      statusMap.set(c.unit, c.status);
      const row = rowOf.get(c.unit);
      if (!row) continue;
      row.dot.className = `dot dot--${c.status}`;
      const last = c.last;
      if (last) {
        row.preview.textContent = clip((last.role === "me" ? "You: " : "") + last.text);
        row.time.textContent = fmtRowTime(last.t);
        row.at = last.t;
      } else {
        row.preview.textContent = "";
        row.time.textContent = "";
        row.at = 0;
      }
      const n = unit?.id === c.unit ? 0 : (c.unread || 0);
      row.badge.hidden = !n;
      row.badge.textContent = n;
      total += n;
    }
    sortRows();
    if (tabBadge) { tabBadge.hidden = !total; tabBadge.textContent = total; }
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
        `<span class="row__time"></span>`;
      btn.addEventListener("click", () => openChat(p));
      li.append(btn);
      chatList.append(li);
      rowOf.set(p.id, {
        li,
        preview: btn.querySelector(".row__text i"),
        time: btn.querySelector(".row__time"),
        dot: btn.querySelector(".row__name .dot"),
        badge: btn.querySelector(".row__badge"),
        at: 0,
      });
    }

    // Fiona's Class：她自己的服务号，和聊天行一样按最近活动时间排序；
    // 点进去后把 at 置为现在，它就会浮上去。没有未读、没有预览。
    let classAt = 0;
    try { classAt = Number(localStorage.getItem("fluentchat:classAt")) || 0; } catch {}
    const fiona = people.find((p) => p.id === "persona-Fiona");
    const classLi = document.createElement("li");
    const classBtn = document.createElement("button");
    classBtn.type = "button";
    classBtn.className = "row row--class";
    classBtn.innerHTML =
      `<span class="row__avwrap"><img class="row__av" src="${fiona?.avatar || "assets/contacts/Fiona/avatar.png"}" alt=""></span>` +
      `<span class="row__text"><b class="row__name">Fiona's Class<i class="row__tag">Class</i></b><i>English, one topic at a time</i></span>` +
      `<span class="row__time"></span>`;
    classBtn.addEventListener("click", () => {
      const now = Date.now();
      const row = rowOf.get("class");
      if (row) row.at = now;
      try { localStorage.setItem("fluentchat:classAt", String(now)); } catch {}
      sortRows();
      openClass?.();
    });
    classLi.append(classBtn);
    chatList.append(classLi);
    rowOf.set("class", { li: classLi, at: classAt });

    refresh();
  });

  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 15_000);

  // ── 小工具 ───────────────────────────────────────────────────────────
  function scrollDown(force) {
    const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (!force && gap > 160) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }
  function setChatState(text) { stateEl.textContent = text; }
  function setCallState(text) { callState.textContent = text; }
  function setReady(on) { ready = on; callBtn.disabled = on; }
  function showStatus() {
    if (unit && !typingEl) setChatState(STATUS_LABEL[statusMap.get(unit.id)] || "");
  }

  function addBubble(who, text, t, opts = {}) {
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
    if (opts.id) node.dataset.id = opts.id;
    if (opts.clientId) node.dataset.clientId = opts.clientId;
    body.append(node);
    if (typingEl) body.append(typingEl);
    scrollDown(true);
    return node;
  }

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("p");
    typingEl.className = "msg msg--ai msg--typing";
    typingEl.innerHTML = "<i></i><i></i><i></i>";
    body.append(typingEl);
    scrollDown(true);
  }
  function hideTyping() {
    if (!typingEl) return;
    typingEl.remove();
    typingEl = null;
  }

  function render(m) {
    if (m.hidden) return;
    // 服务端会重发同一条（乐观气泡的 ack 与它自己的回声撞在一起），画过一次就不再画。
    if (drawnIds.has(m.id)) return;
    drawnIds.add(m.id);
    if (m.kind === "call") { addCallLine({ id: m.client_id, text: m.text }); return; }
    if (m.kind === "review") { addReviewCard(m.text); return; }
    if (m.client_id && pendingNodes.has(m.client_id)) { settle(m.client_id, m.id); return; }
    addBubble(m.role === "me" ? "me" : "ai", m.text, m.t, { id: m.id });
  }

  // 乐观气泡对账：服务端 id 回来（ack 或回声），把气泡钉上 id 并摘出 pending。
  function settle(clientId, id) {
    const node = pendingNodes.get(clientId);
    if (!node) return;
    if (id) node.dataset.id = id;
    pendingNodes.delete(clientId);
  }

  function updateHeader(data) {
    statusMap.set(data.unit, data.status);
    if (data.typing) { showTyping(); setChatState("typing…"); }
    else { hideTyping(); setChatState(STATUS_LABEL[data.status] || ""); }
  }

  let lastSeenSent = 0;
  function seen(seq) {
    if (!unit || !seq || seq <= lastSeenSent) return;
    lastSeenSent = seq;
    fetch("/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unit: unit.id, seq }),
    }).catch(() => {});
    const row = rowOf.get(unit.id);
    if (row) { row.badge.hidden = true; row.badge.textContent = 0; }
  }

  // ── 轮询当前对话 ─────────────────────────────────────────────────────
  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(poll, 1500);
    poll();
  }
  async function poll() {
    if (!unit || pollBusy || document.visibilityState !== "visible") return;
    const u = unit, seq = openSeq;
    pollBusy = true;
    try {
      const res = await fetch(`/conversation?unit=${encodeURIComponent(u.id)}&after=${lastId}`);
      if (!res.ok || seq !== openSeq) return;
      const data = await res.json();
      if (seq !== openSeq) return;
      if (data.messages?.length) {
        hideTyping();
        for (const m of data.messages) {
          if (m.id > lastId) lastId = m.id;
          render(m);
        }
        scrollDown();
      }
      updateHeader(data);
      if (data.messages?.length) seen(lastId);
    } catch {}
    finally { pollBusy = false; }
  }

  // ── 打开 / 关闭 ──────────────────────────────────────────────────────
  async function openChat(u) {
    if (unit === u) { show?.(); return; }
    teardown();
    const seq = ++openSeq;
    unit = u;
    lastId = 0;
    lastSeenSent = 0;
    pendingNodes.clear();

    avImg.src = u.avatar;
    avImg.style.removeProperty("--fx");
    avEl.style.removeProperty("--av");
    callAvImg.src = u.avatar;
    callAvImg.style.removeProperty("--fx");
    callAv.style.removeProperty("--av");
    nameEl.textContent = u.name;
    callSaid.textContent = "";
    setChatState("…");
    setReady(false);

    try {
      const res = await fetch(`/conversation?unit=${encodeURIComponent(u.id)}&limit=50`);
      if (seq !== openSeq || !unit) return;
      if (res.ok) {
        const data = await res.json();
        if (seq !== openSeq) return;
        lastId = data.cursor || 0;
        for (const m of data.messages || []) render(m);
        updateHeader(data);
        if (document.visibilityState === "visible" && lastId) seen(lastId);
      }
    } catch {}
    show?.();
    scrollDown(true);
    startPoll();
  }

  function teardown() {
    openSeq++;
    connectSeq++;
    if (callRec) { flushPending(); finalizeCall(); }
    stopPoll();
    stopMic();
    stopPlayback();
    stopRingback();
    callBox.hidden = true;
    callSaid.textContent = "";
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    playHead = 0;
    unit = null;
    mode = "text";
    pendingAi = "";
    pendingMe = "";
    hideTyping();
    pendingNodes.clear();
    drawnIds.clear();
    lastId = 0;
    lastSeenSent = 0;
    lastStamp = null;
    callBox.hidden = true;
    callSaid.textContent = "";
    for (const n of body.querySelectorAll(".msg, .review")) n.remove();
    setReady(false);
  }

  // ── 发送 ─────────────────────────────────────────────────────────────
  async function sendMessage(text) {
    const u = unit;
    if (!u) return;
    const clientId = crypto.randomUUID();
    const node = addBubble("me", text, Date.now(), { clientId });
    pendingNodes.set(clientId, node);
    try {
      await postMessage(u, text, clientId, node);
    } catch (e) {
      node.classList.add("msg--fail");
      setChatState(e.message || "Send failed");
    }
  }

  async function postMessage(u, text, clientId, node) {
    const res = await fetch("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: u.id, text, client_id: clientId,
        tz: new Date().getTimezoneOffset(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    node.classList.remove("msg--fail");
    if (data.id) {
      // 乐观气泡就是这条服务端消息，它已经上屏了：回声别再画一遍。
      settle(clientId, data.id);
      drawnIds.add(data.id);
    }
    if (data.status === "offline") setChatState("Offline");
    poll();
    refresh();
  }

  // 红叹号点按重发：同一 client_id，服务端幂等。
  async function retrySend(node) {
    const clientId = node.dataset.clientId;
    if (!clientId || !unit) return;
    node.classList.remove("msg--fail");
    pendingNodes.set(clientId, node);
    try { await postMessage(unit, node.textContent, clientId, node); }
    catch (e) { node.classList.add("msg--fail"); setChatState(e.message || "Send failed"); }
  }

  async function resetChat() {
    const u = unit;
    if (!u) return;
    if (!confirm("Clear this chat? The history can't be recovered.")) return;
    await fetch("/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unit: u.id }),
    }).catch(() => {});
    teardown();
    openChat(u);
  }

  // ── AudioContext ─────────────────────────────────────────────────────
  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function stopPlayback() {
    for (const src of liveSources) { try { src.stop(); } catch {} }
    liveSources = [];
    if (audioCtx) playHead = audioCtx.currentTime;
  }

  function playAudioBase64(b64) {
    if (!b64) return;
    stopRingback();
    if (mode === "call") setCallState("On call");
    try {
      const ctx = ensureAudio();
      const bin = atob(b64);
      const samples = bin.length >> 1;
      if (!samples) return;
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const buf = ctx.createBuffer(1, samples, OUT_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(playHead, ctx.currentTime);
      src.start(at);
      playHead = at + buf.duration;
      liveSources.push(src);
      src.onended = () => { liveSources = liveSources.filter((s) => s !== src); };
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

  async function startMic() {
    if (micActive || micReady) return;
    try {
      if (!navigator.mediaDevices) {
        throw new Error("Mic is blocked outside HTTPS, browsers won't allow it");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      micStream = stream;
      const ctx = ensureAudio();
      micSrc = ctx.createMediaStreamSource(stream);
      micProc = ctx.createScriptProcessor(4096, 1, 1);
      micProc.onaudioprocess = (e) => {
        if (!micActive || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm = float32ToPcm16Bytes(downsample(input, ctx.sampleRate, MIC_RATE));
        ws.send(JSON.stringify({
          realtimeInput: { audio: { data: base64FromUint8(pcm), mimeType: `audio/pcm;rate=${MIC_RATE}` } },
        }));
      };
      micSink = ctx.createGain();
      micSink.gain.value = 0;
      micSink.connect(ctx.destination);
      micSrc.connect(micProc);
      micProc.connect(micSink);
      micReady = true;
    } catch (err) {
      console.warn("麦克风无法打开:", err);
      callSaid.textContent = `Mic unavailable: ${err.message}`;
    }
  }

  function stopMic() {
    micActive = false;
    for (const node of [micProc, micSrc, micSink]) {
      if (node) { try { node.disconnect(); } catch {} }
    }
    micProc = micSrc = micSink = null;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    micReady = false;
  }

  function enableMic() {
    if (micReady) { micActive = true; return; }
    startMic().then(() => { if (micReady) micActive = true; });
  }

  function openClassCall(u, unitId) {
    startCall(unitId, u);
  }

  // ── 通话 ─────────────────────────────────────────────────────────────
  let callRec = null;
  let ringback = null;
  let ringbackUrl = null;
  setTimeout(() => {
    fetch("assets/DialMusic.m4a")
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => { if (blob) ringbackUrl = URL.createObjectURL(blob); })
      .catch(() => {});
  }, 3000);

  function startRingback() {
    stopRingback();
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

  function startCall(classUnit = null, person = null) {
    const who = person || unit;
    if (!who || mode !== "text" || ws) return;
    ensureAudio();
    startRingback();
    mode = "call";
    callRec = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      unit: classUnit || who.id,
      chatUnit: who.id,
      practice: !!classUnit,
      name: who.name,
      avatar: who.avatar,
      start: Date.now(),
      connected: false,
      turns: [],
    };
    callBox.hidden = false;
    callAvImg.src = who.avatar;
    callAvImg.style.removeProperty("--fx");
    callAv.style.removeProperty("--av");
    callName.textContent = classUnit ? `${who.name} · Class` : who.name;
    callSaid.textContent = "";
    setCallState("Connecting…");
    enableMic();
    connect();
  }

  function hangUp() {
    flushPending();
    stopMic();
    stopPlayback();
    stopRingback();
    callBox.hidden = true;
    callSaid.textContent = "";
    mode = "text";
    finalizeCall();
    showStatus();
    if (ws) { try { ws.close(); } catch {} }
  }

  function finalizeCall() {
    const rec = callRec;
    callRec = null;
    if (!rec || !rec.connected) return null;
    rec.dur = Math.max(0, Date.now() - rec.start);
    const id = saveCall(rec);
    const text = `${rec.practice ? "Class call" : "Voice call"} · ${fmtDur(rec.dur)}`;
    if (rec.practice) openCall?.(id);
    if (!rec.chatUnit?.startsWith("persona-")) return id;
    fetch("/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: rec.chatUnit, turns: rec.turns, practice: rec.practice,
        call: { id, text },
      }),
    }).then(() => { if (!rec.practice) poll(); }).catch(() => {});
    return id;
  }

  function addCallLine(item) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "msg msg--call";
    node.textContent = item.text || `${item.practice ? "Class call" : "Voice call"} · ${fmtDur(item.dur)}`;
    node.dataset.id = item.id || "";
    if (item.id) node.addEventListener("click", () => openCall?.(item.id));
    body.append(node);
    scrollDown(true);
    return node;
  }

  function addReviewCard(text) {
    const card = document.createElement("div");
    card.className = "review";
    const label = document.createElement("p");
    label.className = "review__label";
    label.textContent = "Review notes";
    const t = document.createElement("p");
    t.className = "review__text";
    t.textContent = text;
    card.append(label, t);
    body.append(card);
    scrollDown(true);
    return card;
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function abortCall(u, msg) {
    if (!callRec || u !== callRec.chatUnit) return;
    const practice = callRec.practice;
    const connected = callRec.connected;
    stopMic();
    stopPlayback();
    stopRingback();
    mode = "text";
    flushPending();
    finalizeCall();
    if (practice && !connected) {
      callBox.hidden = false;
      setCallState("Call failed");
      callSaid.textContent = msg;
    } else {
      callBox.hidden = true;
      callSaid.textContent = "";
      setChatState(msg);
    }
    const sock = ws;
    ws = null;
    if (sock) { try { sock.close(); } catch {} }
  }

  async function connect() {
    const u = callRec?.chatUnit;
    if (!u) return;
    const seq = ++connectSeq;
    const practice = callRec.practice;
    const target = callRec.unit;
    setChatState("Connecting…");
    let token;
    const grabToken = () => fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unit: target, tz: new Date().getTimezoneOffset(), practice }),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      return data.token;
    });
    try {
      try {
        token = await grabToken();
      } catch (e) {
        setChatState("Connecting… (retrying)");
        await new Promise((r) => setTimeout(r, 500));
        if (seq !== connectSeq || callRec?.chatUnit !== u || mode !== "call") return;
        token = await grabToken();
      }
    } catch (e) {
      if (seq !== connectSeq || callRec?.chatUnit !== u) return;
      const why = [e.message, e.name && e.name !== "Error" ? `(${e.name})` : "",
        e.cause ? `[${e.cause}]` : ""].filter(Boolean).join(" ");
      abortCall(u, `Can't start a call: ${why}`);
      return;
    }
    if (seq !== connectSeq || callRec?.chatUnit !== u || mode !== "call") return;

    const sock = new WebSocket(`${WS_BASE}?access_token=${token}`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live" } }));
    sock.onmessage = (e) => { if (ws === sock) onMessage(e); };
    sock.onerror = () => { if (ws === sock && callRec?.chatUnit === u) abortCall(u, "Connection error"); };
    sock.onclose = () => { if (ws === sock) onClose(u); };
  }

  function onClose(u) {
    const active = !!callRec && u === callRec.chatUnit;
    const practice = active && callRec.practice;
    const connected = active && callRec.connected;
    stopMic();
    stopPlayback();
    stopRingback();
    flushPending();
    ws = null;
    const wasCall = mode === "call";
    mode = "text";
    callBox.hidden = true;
    callSaid.textContent = "";
    if (active && wasCall) finalizeCall();
    showStatus();
    if (active && wasCall) setChatState("Call dropped");
    if (practice && wasCall && !connected) {
      callBox.hidden = false;
      setCallState("Call dropped");
      callSaid.textContent = "Voice connection closed before it started.";
    }
    if (!practice) poll();
  }

  function mergeChunk(buf, line) {
    if (!buf) return line;
    if (line.includes(buf)) return line;
    if (buf.includes(line)) return buf;
    return buf + line;
  }

  function flushPending() {
    hideTyping();
    if (!callRec) { pendingMe = ""; pendingAi = ""; return; }
    const now = Date.now();
    if (pendingMe) {
      const text = clean(pendingMe);
      pendingMe = "";
      if (text) callRec.turns.push({ who: "me", text, t: now });
    }
    if (pendingAi) {
      const text = clean(pendingAi);
      pendingAi = "";
      if (text) callRec.turns.push({ who: "ai", text, t: now + 1 });
    }
  }

  async function onMessage(e) {
    const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
    if (!raw.trim().startsWith("{")) return;
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (d.error) { hideTyping(); noteError(`出错：${d.error.message || d.error}`); return; }

    if (d.setupComplete) {
      setReady(true);
      if (callRec) callRec.connected = true;
      if (mode === "call") {
        setCallState("Connected — waiting…");
        send({ realtimeInput: { text: "Hello?" } });
        send({ realtimeInput: { activityEnd: {} } });
      }
      return;
    }

    const sc = d.serverContent || {};
    if (sc.interrupted) { stopPlayback(); flushPending(); }

    const mine = sc.inputTranscription?.text;
    if (mine) pendingMe = mergeChunk(pendingMe, mine);
    const line = sc.outputTranscription?.text;
    if (line) {
      pendingAi = mergeChunk(pendingAi, line);
      if (mode === "call") callSaid.textContent = pendingAi;
    }

    if (mode === "call") {
      const turnParts = sc.modelTurn?.parts;
      if (turnParts && Array.isArray(turnParts)) {
        for (const p of turnParts) {
          if (p.inlineData && p.inlineData.data) playAudioBase64(p.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      flushPending();
      showStatus();
    }
  }

  function noteError(text) {
    if (mode === "call") callSaid.textContent = text;
    else setChatState(text);
  }

  // ── 交互 ─────────────────────────────────────────────────────────────
  backBtn.addEventListener("click", () => back?.());
  callBtn.addEventListener("click", () => startCall());
  callEnd.addEventListener("click", hangUp);
  resetBtn.addEventListener("click", resetChat);

  const fitInput = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      bar.requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    sendBtn.disabled = !input.value.trim();
    fitInput();
  });

  body.addEventListener("click", (e) => {
    const fail = e.target.closest?.(".msg--fail");
    if (fail) retrySend(fail);
  });

  bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    fitInput();
    sendBtn.disabled = true;
    if (mode === "call") {
      const t = Date.now();
      if (callRec) callRec.turns.push({ who: "me", text, t });
      send({ realtimeInput: { text } });
      return;
    }
    sendMessage(text);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { stopPoll(); return; }
    if (unit) { poll(); startPoll(); }
    refresh();
  });
  window.addEventListener("pageshow", () => {
    if (unit) { poll(); startPoll(); }
    refresh();
  });

  return {
    close: teardown,
    refresh,
    refreshStatuses: refresh,
    open: openChat,
    openClassCall,
  };
}
