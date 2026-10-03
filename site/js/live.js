// 连 Gemini Live：拿 token → 建 WebSocket → 发空格唤醒 AI。
// 音频双向：AI 声音在浏览器直接播（24kHz PCM16），麦克风分片上行（16kHz PCM16）。
// Worker 全程只签 token，不碰音频。

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
  "v1beta.GenerativeService.BidiGenerateContentConstrained";

// 音频采样率。Gemini Live 的硬性约定：输入 16kHz、输出 24kHz，都是单声道 PCM16。
const MIC_RATE = 16000;
const OUT_RATE = 24000;

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
  let wakeSent = false;
  let micStream = null;
  let micSrc = null;
  let micProc = null;
  let micSink = null;
  let micActive = false;
  let micReady = false;
  let micStartTimer = null;

  // 播放用：playHead 是下一段音频该排到的时刻，分片才不会互相重叠/断音
  let playHead = 0;
  let liveSources = [];

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
    stopPlayback();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    wakeSent = false;
    playHead = 0;
    talk.hidden = true;
    said.textContent = "";
    for (const b of list.querySelectorAll(".unit")) b.disabled = false;
  }


  // 建/唤醒 AudioContext。必须在用户手势里同步调一次，
  // 否则 iOS/Chrome 会把它停在 suspended，麦克风和播放一起哑掉。
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
  // decodeAudioData 解不了它（promise 直接 reject）。之前就是这里静音：
  // 那句 .catch(() => {}) 把错误吞了，听不到也看不到。
  // 正确做法是自己转 Float32 塞进 AudioBuffer，再按 playHead 排队播。
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
      status(`播放失败：${e.message}`);
    }
  }
  function base64FromUint8(buf) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    return btoa(bin);
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
        const pcm = float32ToPcm16Bytes(
          downsample(input, ctx.sampleRate, MIC_RATE)
        );
        const b64 = base64FromUint8(pcm);
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: b64,
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
      said.textContent = `麦克风打不开：${err.message}`;
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

  endBtn.addEventListener("click", close);

  async function start(unit, btn) {
    // 趁这次点击（用户手势）解锁 AudioContext：手机才肯出声、才肯采麦克风
    ensureAudio();
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

      // 你插话时模型会被打断，已排队的音频要立刻停，不然它会继续念下去
      if (sc.interrupted) stopPlayback();

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
      stopPlayback();
      if (talk.hidden) return;
      wakeSent = false;
      status("已断开");
      for (const b of list.querySelectorAll(".unit")) b.disabled = false;
    };

    onOpen?.(unit, ws);
  }
}