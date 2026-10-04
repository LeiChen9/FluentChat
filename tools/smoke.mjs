// 冒烟测试：不依赖浏览器，用 DOM / AudioContext / WebSocket 的桩把
// 站点的完整交互跑一遍 —— 进聊天页 → setupComplete → 打字气泡 → 通话 →
// 挂断 → 复盘流式写卡片 → 返回列表。
//
// 没有浏览器和麦克风的环境里，这是唯一能验证 live.js 逻辑的手段。
// 跑法：node tools/smoke.mjs   （最后一行打印 SMOKE PASS 即通过）
// 桩只认 live.js 用到的那些 DOM 属性和事件；改了 DOM 结构记得同步这里。
const els = new Map();
function match(el, sel) {
  const want = sel.split(",").map((s) => s.trim().replace(/^\./, ""));
  const have = (el.className || "").split(/\s+/).filter(Boolean);
  return want.some((w) => have.includes(w));
}
function mkEl(id = "", tag = "div") {
  const e = {
    id, tag, className: "", textContent: "", value: "", placeholder: "",
    disabled: false, hidden: false, type: "", innerHTML: "",
    dataset: {}, children: [],
    style: { setProperty() {}, removeProperty() {} },
    get classList() {
      const self = this;
      const set = () => { self.className = self._cls.join(" "); };
      const arr = () => (self._cls ||= (self.className || "").split(/\s+/).filter(Boolean));
      return {
        add(c) { if (!arr().includes(c)) { arr().push(c); set(); } },
        remove(c) { self._cls = arr().filter((x) => x !== c); set(); },
        contains(c) { return arr().includes(c); },
        toggle(c, on) { on ? this.add(c) : this.remove(c); },
      };
    },
    _l: {},
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); },
    fire(t, ev) { (this._l[t] || []).forEach((f) => f(ev || { preventDefault() {} })); },
    append(...n) { this.children.push(...n); },
    remove() {},
    replaceChildren(...n) { this.children = n; },
    setAttribute() {}, getAttribute() { return null; },
    scrollTo() {},
    querySelector(sel) { return this.querySelectorAll(sel)[0] || mkEl("", "img"); },
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => { for (const c of el.children) { if (match(c, sel)) out.push(c); walk(c); } };
      walk(this); return out;
    },
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  };
  return e;
}
for (const i of ["brand","greeting","unit-list","chat-name","chat-state","chat-av",
  "chat-body","chat-bar","chat-input","chat-send","chat-back","chat-call",
  "call","call-av","call-name","call-state","call-said","call-end",
  "view-home","view-unit","view-me","view-chat"]) els.set(i, mkEl(i));
const tabs = [
  Object.assign(mkEl("", "button"), { dataset: { view: "free" }, disabled: true }),
  Object.assign(mkEl("", "button"), { dataset: { view: "unit" } }),
  Object.assign(mkEl("", "button"), { dataset: { view: "me" } }),
];
globalThis.document = {
  getElementById: (i) => els.get(i) || null,
  createElement: (t) => mkEl("", t),
  querySelector: (s) => (s === ".topbar" ? mkEl("", "header") : mkEl()),
  querySelectorAll: (s) => (s === ".tab" ? tabs : []),
};
class AC {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBuffer(c, l, r) { return { duration: l / r, getChannelData: () => new Float32Array(l) }; }
  createBufferSource() { return { connect() {}, start() {}, onended: null }; }
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
}
globalThis.window = { AudioContext: AC };
const WSS = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(u) { this.url = u; this.readyState = 1; this.sent = []; WSS.push(this); }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({ token: "tok", model: "m" }) });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// 用 import.meta.url 拼相对路径，换 checkout 也能跑。
await import(new URL("../site/js/app.js", import.meta.url).href);
console.log("✓ 模块加载");
console.log("✓ 列表渲染", els.get("unit-list").children.length, "行");

tabs[1].fire("click");
const row = els.get("unit-list").children[0].children[0];
row.fire("click");
await tick(10);                       // 等 fetch
console.log("✓ 进聊天页:", !els.get("view-chat").hidden, "| name:", els.get("chat-name").textContent);

const ws = WSS[WSS.length - 1];
ws.onopen();
ws.onmessage({ data: JSON.stringify({ setupComplete: true }) });
console.log("✓ 唤醒消息:", ws.sent[1]);
console.log("✓ 输入框解锁:", !els.get("chat-input").disabled, "| 通话键解锁:", !els.get("chat-call").disabled);

const emit = (o) => ws.onmessage({ data: JSON.stringify(o) });
emit({ serverContent: { outputTranscription: { text: "Hi! What's your name?" } } });
let body = els.get("chat-body");
console.log("✓ AI 首条气泡:", body.children[0].className, "|", body.children[0].textContent);

// 打字
els.get("chat-input").value = "I'm Rice.";
els.get("chat-bar").fire("submit", { preventDefault() {} });
console.log("✓ 我的气泡:", body.children[1].className, "|", body.children[1].textContent);
emit({ serverContent: { turnComplete: true } });

// 打电话
els.get("chat-call").fire("click");
console.log("✓ 通话中 call.hidden =", !els.get("call").hidden, "| 状态:", els.get("call-state").textContent);
emit({ serverContent: { inputTranscription: { text: "I am Rice." } },
       });
emit({ serverContent: { outputTranscription: { text: "Nice to meet you, Rice!" } } });
console.log("✓ 通话字幕:", els.get("call-said").textContent);

// 挂断 → 复盘
els.get("call-end").fire("click");
console.log("✓ 挂断后 call.hidden =", els.get("call").hidden);
await tick(760);                      // 等 700ms 缓冲
const card = body.children[body.children.length - 1];
console.log("✓ 复盘卡片:", card.className, "|", card.children[0].textContent,
            "|", card.children[1].textContent);
console.log("✓ 复盘卡片 class:", card.className);
await tick(760);   // 过 700ms 宽限，再让模型收尾
emit({ serverContent: { outputTranscription: { text: "做得好的：能主动反问。要改的：别只回一个词，试着说整句。" } } });
console.log("✓ 复盘流式 class:", card.className, "|", card.children[1].textContent.slice(0, 16) + "…");
emit({ serverContent: { turnComplete: true } });
console.log("✓ 复盘收尾 class:", card.className, "|", card.children[1].textContent.slice(0, 16) + "…");
console.log("✓ 卡片没被清掉:", body.children.includes(card));

// 返回列表
els.get("chat-back").fire("click");
console.log("✓ 返回:", !els.get("view-chat").hidden === false, "view-unit:", !els.get("view-unit").hidden,
            "| ws 关闭:", ws.readyState === 3);
console.log("SMOKE PASS");
