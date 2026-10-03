// 连 Gemini Live：拿 token → 建 WebSocket → 发空格唤醒 AI。
// 这一步只把 AI 说的话转成文字显示，不播声音、不发麦克风。

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
  "v1beta.GenerativeService.BidiGenerateContentConstrained";

// Unit 标题，和 prompts/unit-XX.md 的「话题」对应
const UNITS = [
  { id: "unit-01", title: "Introduce Yourself", cn: "聊你自己" },
  { id: "unit-02", title: "Talk About Today", cn: "聊今天" },
  { id: "unit-03", title: "Food and Coffee", cn: "聊吃的喝的" },
  { id: "unit-04", title: "Weekend Plans", cn: "聊周末" },
  { id: "unit-05", title: "Where You Live", cn: "聊你住的地方" },
  { id: "unit-06", title: "Free Time", cn: "聊空闲时间" },
];

export function initUnits({ onOpen, onStatus }) {
  const list = document.getElementById("unit-list");
  const talk = document.getElementById("talk");
  const label = document.getElementById("talk-label");
  const said = document.getElementById("talk-said");
  const endBtn = document.getElementById("talk-end");

  let ws = null;
  let audioCtx = null;
  let playDest = null;
  let wakeSent = false;
  let micStream = null;
  let micSrc = null;
  let micProc = null;
  let micActive = false;
  let micReady = false;
  let micStartTimer = null;

  // ── 渲染列表 ──
  for (const unit of UNITS) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit";
    btn.innerHTML =
      `<span class="unit__no">${unit.id.slice(-2)}</span>` +
      `<span class="unit__text"><b>${unit.title}</b><i>${unit.cn}</i></span>`;
    btn.addEventListener("click", () => start(unit, btn));
    li.append(btn);
    list.append(li);
  }

  function status(text, talking = false) {
    label.textContent = text;
    talk.classList.toggle("is-live", talking);
    onStatus?.(text);
  }

  function close() {
    if (micStartTimer) {
      clearTimeout(micStartTimer);
      micStartTimer = null;
    }
    stopMic();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    wakeSent = false;
    talk.hidden = true;
    said.textContent = "";
    for (const b of list.querySelectorAll(".unit")) b.disabled = false;
  }


  function playAudioBase64(b64) {
    if (!b64) return;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) {
        audioCtx = new Ctx({ sampleRate: 24000 });
      }
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      audioCtx.decodeAudioData(buf).then((ab) => {
        const src = audioCtx.createBufferSource();
        src.buffer = ab;
        src.connect(audioCtx.destination);
        src.start();
      }).catch(() => {});
    } catch (e) {}
  }
  function base64FromUint8(buf) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function floatToInt16(float32Array) {
    const len = float32Array.length;
    const int16 = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      let s = float32Array[i];
      if (s > 1) s = 1;
      if (s < -1) s = -1;
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  async function startMic() {
    if (micActive || micReady) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micStream = stream;

      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) {
        audioCtx = new Ctx({ sampleRate: 24000 });
      }
      micSrc = audioCtx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      micProc = audioCtx.createScriptProcessor(bufferSize, 1, 1);

      micProc.onaudioprocess = (e) => {
        if (!micActive || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm = floatToInt16(input);
        const b64 = base64FromUint8(pcm);
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: b64,
                mimeType: "audio/pcm;rate=24000",
              },
            },
          })
        );
      };

      micSrc.connect(micProc);
      micProc.connect(audioCtx.destination);
      micReady = true;
    } catch (err) {
      console.warn("麦克风无法打开:", err);
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

  endBtn.addEventListener("click", close);

  async function start(unit, btn) {
    for (const b of list.querySelectorAll(".unit")) b.disabled = true;
    talk.hidden = false;
    status(`正在连接 ${unit.title}…`);

    // 1. 换一次性 token。prompt 钉在 token 里，前端碰不到。
    let token;
    try {
      const res = await fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit: unit.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
      token = data.token;
    } catch (e) {
      status(`拿 token 失败：${e.message}`);
      for (const b of list.querySelectorAll(".unit")) b.disabled = false;
      return;
    }

    // 2. 直连 Gemini（音频不经过 Worker）
    ws = new WebSocket(`${WS_BASE}?access_token=${token}`);
    ws.binaryType = "arraybuffer";


    ws.onopen = () => {
      status("连接中…");
      // 第一条消息必须带 setup
      ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live" } }));
    };

    ws.onmessage = async (e) => {
      // 服务端可能在二进制帧里发 JSON，必须解出来
      const raw =
        typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      if (!raw.trim().startsWith("{")) return; // 音频数据，下一步再处理

      let d;
      try { d = JSON.parse(raw); } catch { return; }

      if (d.error) { status(`出错：${d.error.message || d.error}`); return; }

      // setupComplete 后发一个空格唤醒 AI。Gemini 不会自己开口。
      if (d.setupComplete && !wakeSent) {
        wakeSent = true;
        ws.send(JSON.stringify({ realtimeInput: { text: " " } }));
        if (micStartTimer) clearTimeout(micStartTimer);
        micStartTimer = setTimeout(() => {
          enableMic();
        }, 600);
        return;
      }

      const sc = d.serverContent || {};
      const line = sc.outputTranscription?.text;
      if (line) {
        said.textContent = line; // 增量转写，直接覆盖
        status(`${unit.title} — AI 正在说…`, true);
      }
      const turnParts = sc.modelTurn?.parts;
      if (turnParts && Array.isArray(turnParts)) {
        for (const p of turnParts) {
          if (p.inlineData && p.inlineData.data) {
            playAudioBase64(p.inlineData.data);
          }
        }
      }

      if (sc.turnComplete) status(`${unit.title} — 轮到你了`, true);
    };

    ws.onerror = () => status("连接出错");
    ws.onclose = () => {
      if (micStartTimer) {
        clearTimeout(micStartTimer);
        micStartTimer = null;
      }
      stopMic();
      if (talk.hidden) return;
      wakeSent = false;
      status("已断开");
      for (const b of list.querySelectorAll(".unit")) b.disabled = false;
    };

    onOpen?.(unit, ws);
  }
}