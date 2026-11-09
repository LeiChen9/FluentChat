// 冒烟测试：不依赖浏览器，用 DOM / AudioContext / WebSocket 的桩跑通新消息链：
// 列表从 /conversations 渲染 → 进聊天拉 /conversation → 发消息 POST /messages
// → 轮询拿到 AI 消息 → POST /seen → offline 状态不 typing → reset → 练习卡。
// 跑法：node tools/smoke.mjs （最后一行打印 SMOKE PASS 即通过）
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
    append(...n) {
      for (const c of n) {
        if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
        c.parent = this;
        this.children.push(c);
      }
    },
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
  "view-chats","view-practice","view-calls","view-moments","view-me","view-chat","view-call",
  "practice-list",
  "push-enable","push-note","push-err","profile-err","profile-row","me-avatar",
  "me-user","avatar-file","logout-row","notif-sheet","notif-sheet-close"]) els.set(i, mkEl(i));
const tabs = [
  Object.assign(mkEl("", "button"), { dataset: { view: "chats" } }),
  Object.assign(mkEl("", "button"), { dataset: { view: "practice" } }),
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
  visibilityState: "visible",
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
globalThis.Audio = class { constructor() { this.currentTime = 0; } play() { return Promise.resolve(); } pause() {} };
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` }, configurable: true });
globalThis.confirm = () => true;

const now = Date.now();
let leoStatus = "active";
let cursor = 2;
const calls = [];
let replySent = false;
let allowReply = false;
// 真机竞态：ack 落地后，先前那次轮询的回声才回来 —— 回声带着自己的 id 重发同一条。
let sentCid = null;
const initial = [
  { id: 1, role: "me", kind: "text", text: "Hello Leo", t: now - 5000, hidden: 0, client_id: null },
  { id: 2, role: "ai", kind: "text", text: "Hi Rice", t: now - 4000, hidden: 0, client_id: null },
];
const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
const text = (s) => ({ ok: true, status: 200, text: async () => s });

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
  if (u.includes("assets/contacts")) {
    return u.includes("contact.json")
      ? json({ name: "Leo", status: "", preview: "", time: "", avatar: "a.png",
               base: [10, 60], burst: [0.6, 2], glow: 10, hours: Array(24).fill("active") })
      : text("[]");
  }
  if (u === "/me" || u === "/profile") return json({ user: "riceball" });
  if (u === "/ping" || u === "/away" || u === "/seen" || u === "/reset" || u === "/transcript" || u === "/prefs") return json({ ok: true });
  if (u === "/conversations") {
    return json({ conversations: [
      { unit: "persona-leo", status: leoStatus, wake_at: 0, unread: 0, last: initial[1], typing: false },
      { unit: "persona-chole", status: "active", wake_at: 0, unread: 1, last: initial[1], typing: false },
      { unit: "persona-sam", status: "active", wake_at: 0, unread: 0, last: null, typing: false },
      { unit: "persona-Fiona", status: "active", wake_at: 0, unread: 0, last: null, typing: false },
    ] });
  }
  if (u.startsWith("/conversation?")) {
    const q = new URL("http://x" + u).searchParams;
    const unit = q.get("unit");
    if (unit !== "persona-leo") return json({ unit, status: "active", typing: false, wake_at: 0, reply_due_at: null, cursor: 0, seen: 0, messages: [] });
    if (q.get("after")) {
      if (!allowReply || replySent) return json({ unit, status: leoStatus, typing: false, wake_at: 0, reply_due_at: null, cursor, seen: 0, messages: [] });
      replySent = true;
      cursor = 101;
      // 回声重发用户自己那条：ack 已经把它画过一次了。
      return json({ unit, status: leoStatus, typing: false, wake_at: 0, reply_due_at: null, cursor,
        seen: 0, messages: [
          { id: 100, role: "me", kind: "text", text: "hi", t: now, hidden: 0, client_id: sentCid },
          { id: 101, role: "ai", kind: "text", text: "Midnight shimmer.", t: now, hidden: 0, client_id: null },
        ] });
    }
    return json({ unit, status: leoStatus, typing: false, wake_at: 0, reply_due_at: null, cursor, seen: 0, messages: initial });
  }
  if (u === "/messages") {
    cursor = 100;
    sentCid = JSON.parse(opts.body).client_id;
    return json({ id: 100, t: now, status: leoStatus, wake_at: 0, reply_due_at: now + 4000 });
  }
  if (u === "/token") return json({ token: "tok", model: "m" });
  if (u === "/practice/plan") return json({ units: [
    { id: "unit-01", chapter: "survival", title: "Meet Me", can_do: "认识一个新朋友" },
    { id: "unit-07", chapter: "expression", title: "At Work", can_do: "聊工作日常" },
  ] });
  if (u === "/call-review") return json({ overall: "ok", good: [], improve: [], focus: [], lines: [] });
  return json({});
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

await import(new URL("../site/js/app.js", import.meta.url).href);
await tick(30);
const chatList = els.get("chat-list");
if (chatList.children.length !== 4) throw new Error(`chat rows: ${chatList.children.length}`);
if (!calls.some((c) => c.url === "/ping")) throw new Error("boot did not ping presence");
console.log("✓ 列表渲染 4 行，boot 已 ping");

const body = els.get("chat-body");
chatList.children[0].children[0].fire("click");
await tick(30);
if (body.children.length !== 3) throw new Error(`initial render: ${body.children.length}`);
console.log("✓ 打开对话拉服务端时间线:", body.children.length);

allowReply = true;
els.get("chat-input").value = "hi";
els.get("chat-bar").fire("submit");
await tick(10);
const sent = calls.find((c) => c.url === "/messages");
if (!sent || sent.body.text !== "hi" || !sent.body.client_id) throw new Error("send not posted");
await tick(1700);
if (!body.children.some((n) => n.textContent === "Midnight shimmer.")) throw new Error("AI reply not rendered");
const hiBubbles = body.children.filter((n) => n.textContent === "hi");
if (hiBubbles.length !== 1) throw new Error(`own message drawn ${hiBubbles.length} times`);
const seen = calls.filter((c) => c.url === "/seen").at(-1);
if (!seen || seen.body.seq !== 101) throw new Error(`seen seq: ${seen?.body?.seq}`);
console.log("✓ 发送落库、轮询收 AI 消息、已读回执 101");

leoStatus = "offline";
els.get("chat-back").fire("click");
chatList.children[0].children[0].fire("click");
await tick(30);
if (els.get("chat-state").textContent !== "Offline") throw new Error(`offline header: ${els.get("chat-state").textContent}`);
if (body.querySelectorAll(".msg--typing").length) throw new Error("offline shows typing");
console.log("✓ offline 不 typing，顶栏 Offline");

els.get("chat-reset").fire("click");
await tick(20);
if (!calls.some((c) => c.url === "/reset")) throw new Error("reset not posted");
console.log("✓ reset 清服务端时间线");

tabs[1].fire("click");
await tick(20);
const practiceRows = els.get("practice-list").children
  .flatMap((c) => c.children || [])
  .filter((c) => String(c.className).includes("practice-row"));
if (practiceRows.length !== 2) throw new Error(`practice rows: ${practiceRows.length}`);
practiceRows[0].fire("click");
await tick(20);
const practiceToken = calls.find((c) => c.url === "/token" && c.body?.practice);
if (!practiceToken || practiceToken.body.unit !== "unit-01") throw new Error("practice token missing");
console.log("✓ 练习卡仍能拨打");
console.log("SMOKE PASS");
process.exit(0);
