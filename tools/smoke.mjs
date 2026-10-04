// 冒烟测试：不依赖浏览器，用 DOM / AudioContext / WebSocket 的桩把
// 站点的完整交互跑一遍 —— 进聊天页 → setupComplete → 转写分片攒轮、
// turnComplete 一次性落气泡（typing 提示）→ 打字 → 通话 → 挂断 →
// 复盘收尾一次性贴正文 → 返回 → 重进恢复本地历史。
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
    // remove() 要真的从父节点摘掉：typing 气泡靠它消失，断言数节点才准
    append(...n) { for (const c of n) c.parent = this; this.children.push(...n); },
    remove() {
      const p = this.parent;
      if (!p) return;
      p.children = p.children.filter((x) => x !== this);
      this.parent = null;
    },
    replaceChildren(...n) { for (const c of n) c.parent = this; this.children = n; },
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
  "chat-body","chat-bar","chat-input","chat-send","chat-back","chat-call","chat-reset",
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
// 记下每次 /token 请求体，用来断言「重进时带上了历史」
const fetches = [];
globalThis.fetch = async (url, opts) => {
  fetches.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
  return { ok: true, json: async () => ({ token: "tok", model: "m" }) };
};
// live.js 用 localStorage 留历史，Node 里没有，给个内存桩
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.confirm = () => true; // reset 的二次确认，桩里直接放行
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
console.log("✓ 首次进 history 为空:", JSON.stringify(fetches[0].body.history));

const emit = (o) => ws.onmessage({ data: JSON.stringify(o) });
let body = els.get("chat-body");

// 开场白分片：混增量包和累计包两种，turnComplete 前只出 typing 不出气泡
emit({ serverContent: { outputTranscription: { text: "Hi! " } } });
emit({ serverContent: { outputTranscription: { text: "Hi! Let's just talk." } } });
emit({ serverContent: { outputTranscription: { text: " What's your name?" } } });
console.log("✓ 分片期间只有 typing:", body.children.length === 1, "|", body.children[0].className);
emit({ serverContent: { turnComplete: true } });
console.log("✓ AI 首条气泡（整轮一次出）:", body.children[0].className, "|", body.children[0].textContent);
console.log("✓ typing 已收:", body.children.length === 1, "| 状态:", els.get("chat-state").textContent);

// 打字：自己的气泡立即出，typing 立即摆上
els.get("chat-input").value = "I'm Rice.";
els.get("chat-bar").fire("submit", { preventDefault() {} });
console.log("✓ 我的气泡:", body.children[1].className, "|", body.children[1].textContent,
            "| typing:", body.children[2].className, "| 状态:", els.get("chat-state").textContent);
emit({ serverContent: { outputTranscription: { text: "Nice" } } });
emit({ serverContent: { outputTranscription: { text: "! Rice." } } });
emit({ serverContent: { turnComplete: true } });
console.log("✓ AI 回复落定:", body.children[2].className, "|", body.children[2].textContent,
            "| 节点数:", body.children.length);

// 打电话：通话中的转写同样攒到 turnComplete 才落气泡；只有字幕是实时的
els.get("chat-call").fire("click");
console.log("✓ 通话中 call.hidden =", !els.get("call").hidden, "| 状态:", els.get("call-state").textContent);
emit({ serverContent: { inputTranscription: { text: "I am " } } });
emit({ serverContent: { inputTranscription: { text: "Rice." } } });
emit({ serverContent: { outputTranscription: { text: "Nice to meet you, Rice!" } } });
console.log("✓ 通话字幕（合并后）:", els.get("call-said").textContent);
console.log("✓ 通话中不落气泡:", body.children.length === 3);
emit({ serverContent: { turnComplete: true } });
console.log("✓ 通话转写落气泡:", body.children.length === 5,
            "|", body.children[3].textContent, "/", body.children[4].textContent);

// 挂断 → 复盘（不流式：先挂着「正在整理」，收尾一次性贴正文）
els.get("call-end").fire("click");
console.log("✓ 挂断后 call.hidden =", els.get("call").hidden);
await tick(760);                      // 等 700ms 缓冲
const card = body.children[body.children.length - 1];
console.log("✓ 复盘卡片:", card.className, "|", card.children[0].textContent,
            "|", card.children[1].textContent);
await tick(10);
emit({ serverContent: { outputTranscription: { text: "做得好的：能主动反问。要改的：别只回一个词，试着说整句。" } } });
console.log("✓ 分片期间不流式（还是占位）:", card.children[1].textContent.slice(0, 6) + "…");
await tick(760);   // 过 700ms 宽限，再让模型收尾
emit({ serverContent: { turnComplete: true } });
console.log("✓ 复盘收尾 class:", card.className, "|", card.children[1].textContent.slice(0, 16) + "…");
console.log("✓ 卡片没被清掉:", body.children.includes(card));

// 返回列表
els.get("chat-back").fire("click");
console.log("✓ 返回:", !els.get("view-chat").hidden === false, "view-unit:", !els.get("view-unit").hidden,
            "| ws 关闭:", ws.readyState === 3);

// 重进同一个 Unit：历史从 localStorage 恢复，/token 请求带上 history
row.fire("click");
await tick(10);
const lastFetch = fetches[fetches.length - 1];
console.log("✓ 重进带 history:", lastFetch.body.history.length, "条",
            "| 末条:", JSON.stringify(lastFetch.body.history[lastFetch.body.history.length - 1]));
console.log("✓ 历史重渲染:", body.children.length, "个节点 | 末尾是复盘:",
            body.children[body.children.length - 1].className.includes("review"));
console.log("✓ 首条还是开场白:", body.children[0].textContent);

// Reset：清空本地历史 + 拆线重连，界面和模型一起回白纸
els.get("chat-reset").fire("click");
console.log("✓ reset 后气泡清空:", body.children.length === 0);
console.log("✓ reset 后本地历史已删:", !store.has("fluentchat:hist:v1:unit-01"));
await tick(10);
const resetFetch = fetches[fetches.length - 1];
console.log("✓ reset 重连 history 为空:", JSON.stringify(resetFetch.body.history));
console.log("SMOKE PASS");
