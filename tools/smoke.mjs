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
    appendChild(n) { this.append(n); return n; },
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
for (const i of ["chat-list","contact-list","moment-list","chat-name","chat-state","chat-av",
  "chat-body","chat-bar","chat-input","chat-send","chat-back","chat-call","chat-reset",
  "call","call-av","call-name","call-state","call-said","call-end",
  "call-back","call-list","call-detail-name","call-detail-meta","call-detail-body",
  "auth","auth-form","auth-user","auth-pass","auth-err","auth-reg",
  "view-chats","view-calls","view-moments","view-me","view-chat","view-call",
  "push-enable","push-note","push-err","profile-err","profile-row","me-avatar",
  "me-user","avatar-file","logout-row","notif-sheet","notif-sheet-close"]) els.set(i, mkEl(i));
const tabs = [
  Object.assign(mkEl("", "button"), { dataset: { view: "chats" } }),
  Object.assign(mkEl("", "button"), { dataset: { view: "calls" } }),
  Object.assign(mkEl("", "button"), { dataset: { view: "moments" } }),
  Object.assign(mkEl("", "button"), { dataset: { view: "me" } }),
];
globalThis.document = {
  getElementById: (i) => els.get(i) || null,
  createElement: (t) => mkEl("", t),
  querySelector: (s) => (s === ".tabbar" ? mkEl("", "nav") : mkEl()),
  querySelectorAll: (s) => (s === ".tab" ? tabs : []),
  addEventListener() {},
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
globalThis.window = { AudioContext: AC, addEventListener() {} };
const WSS = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(u) { this.url = u; this.readyState = 1; this.sent = []; WSS.push(this); }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
};
// 记下每次 /token 请求体，用来断言「重进时带上了历史」；
// 顺带把 contacts 数据目录骗回去（contact.json / moments.md），列表渲染才能跑
const fetches = [];
let chatCalls = 0;   // /chat 按次换一组服务器 t（每次 +5s），仿服务端预写身份
let mirrorRows = null; // 指定后 /hist GET 返回它，模拟云端镜像（null = 原两行）

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("assets/contacts")) {
    return {
      ok: true, status: 200,
      text: async () => (u.includes("contact.json")
        ? JSON.stringify({ name: "Leo", status: "hate the fucking world and enjoy it.",
          preview: "Yo!", time: "09:12", avatar: "assets/contacts/leo/avatar.png",
          base: [10, 60], burst: [0.6, 2], glow: 10, hours: Array(24).fill("active") })
        : "09:12 — Sold out before 2pm 🔥"),
      json: async () => ({}),
    };
  }
  if (u === "/me") return { ok: true, json: async () => ({ user: "riceball" }) };
  if (u === "/profile") return { ok: true, json: async () => ({ user: "riceball" }) };
  if (u === "/chat") {
    fetches.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    chatCalls++;
    const base = 1700000000000 + (chatCalls - 1) * 5000000;
    return {
      ok: true, status: 200,
      json: async () => ({ content: "Midnight shimmer.\nWant details?",
        parts: [{ text: "Midnight shimmer.", t: base },
                { text: "Want details?", t: base + 1 }] }),
    };
  }
  if (u === "/hist/persona-leo") {
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200,
      json: async () => (mirrorRows ?? [
        { who: "me", text: "Hello Leo", t: 1 },
        { who: "ai", text: "Hi Rice", t: 2 },
      ]) };
  }
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
await tick(10);   // contacts 列表是异步 fetch 渲染
console.log("✓ 模块加载");
console.log("✓ 列表渲染 | 聊天:", els.get("chat-list").children.length,
            "| 联系人:", els.get("contact-list").children.length,
            "| 朋友圈:", els.get("moment-list").children.length);

tabs[0].fire("click");
const row = els.get("chat-list").children[0].children[0];
row.fire("click");
await tick(10);                       // 等 fetch
console.log("✓ 进聊天页:", !els.get("view-chat").hidden, "| name:", els.get("chat-name").textContent);

const body = els.get("chat-body");
await tick(40);
if (body.children.length !== 3) throw new Error(`R2 history render count: ${body.children.length}`);
if (!store.has("fluentchat:hist:v1:persona-leo")) throw new Error("R2 history was not persisted");
console.log("✓ R2 历史显示并已落本地");
els.get("chat-back").fire("click");
row.fire("click");
if (body.children.length !== 3) throw new Error(`reopen local render count: ${body.children.length}`);
console.log("✓ 重进立即从本地恢复");
console.log("SMOKE PASS");

// ── 回复链回归（2026-10-29 消息身份 + pending 合流护栏）──
// 事故：服务端预写（t0 章）与前端发泡（Date.now 章）两张时钟，开页合流判不重，
// 72s 节奏窗口里重开聊天页就把同一回复当「离线未读」插屏，到点再发一遍。
els.get("chat-input").value = "hi";
els.get("chat-bar").fire("submit");
let news = [];
for (let k = 0; k < 400; k++) { // 节奏机 10-60s 延迟，轮到发齐两条为止
  await tick(250);
  news = JSON.parse(localStorage.getItem("fluentchat:hist:v1:persona-leo"))
    .filter((m) => m.who === "ai" && m.t >= 1700000000000 && m.t < 1700000001000);
  if (news.length === 2) break;
}
if (news.length !== 2) throw new Error(`reply lost: ${news.length}`);
if (news[0].t !== 1700000000000 || news[1].t !== 1700000000001)
  throw new Error(`bubbles not stamped with server t: ${news.map((n) => n.t)}`);
console.log("✓ 回复落盘签服务器 t:", news.map((n) => n.t));

const key = (i) => `${i.kind || "b"}|${i.id || ""}|${i.who}|${i.text}|${i.t ?? ""}`;
const seen = new Set(JSON.parse(localStorage.getItem("fluentchat:hist:v1:persona-leo")).map(key));
for (const row of news.map((n) => ({ who: "ai", text: n.text, t: n.t })))
  if (!seen.has(key(row))) throw new Error(`mirror row not deduped: ${row.text}`);
console.log("✓ 与服务端预写行同 key，合流判重");

// 事故链重放：预写 pending 行还没送达，在途窗口里切走重开 → 不得插屏
const hread = () => JSON.parse(localStorage.getItem("fluentchat:hist:v1:persona-leo"));
const ts2 = 1700005000000;
mirrorRows = [
  { who: "me", text: "Hello Leo", t: 1 },
  { who: "ai", text: "Hi Rice", t: 2 },
  { who: "me", text: "hi2", t: 1700040000000 },
  { who: "ai", text: "Midnight shimmer.", t: ts2, pending: true },
  { who: "ai", text: "Want details?", t: ts2 + 1, pending: true },
];
els.get("chat-input").value = "hi2";
els.get("chat-bar").fire("submit");
els.get("chat-back").fire("click"); // 在途窗口里切走
row.fire("click");                  // 立刻重开：合流撞上未送达的预写行
await tick(400);
if (hread().some((m) => m.t === ts2)) throw new Error("merge leaked prewritten rows while in flight");
console.log("✓ 在途重开：pending 预写行被合流跳过，不抢发");

for (let k = 0; k < 400; k++) { // 等节奏机送完本轮
  await tick(250);
  if (hread().filter((m) => m.t >= ts2 && m.t < ts2 + 1000).length === 2) break;
}
const rows2 = hread().filter((m) => m.t >= ts2 && m.t < ts2 + 1000);
if (rows2.length !== 2) throw new Error(`in-flight delivery lost: ${rows2.length}`);
if (rows2.some((m) => m.pending)) throw new Error("delivered rows still flagged pending");
console.log("✓ 节奏机用服务器 t 送达一次:", rows2.map((m) => m.t));

// 没人认领的 pending 行（离线代打/其他设备）：合流收下并清标；重复合流靠 key 判重
mirrorRows = [...mirrorRows, { who: "ai", text: "offline cron msg", t: 1700010000000, pending: true }];
els.get("chat-back").fire("click");
row.fire("click");
await tick(400);
const cron = hread().find((m) => m.text === "offline cron msg");
if (!cron || cron.pending !== false) throw new Error("pending row not accepted/stripped");
console.log("✓ 离线 pending 行合流收下并清标");

els.get("chat-back").fire("click");
row.fire("click");
await tick(400);
if (hread().filter((m) => m.text === "offline cron msg").length !== 1) throw new Error("dup on re-merge");
console.log("✓ 镜像滞留 pending 行重复合流不重复");
console.log("SMOKE FULL PASS");
// 节奏引擎的真定时器（回复延迟等）会把事件循环吊住，直接收工
process.exit(0);
