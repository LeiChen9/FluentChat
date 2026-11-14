// 冒烟测试：不依赖浏览器，用 DOM / AudioContext / WebSocket 的桩跑通新消息链：
// 列表从 /conversations 渲染 → 进聊天拉 /conversation → 发消息 POST /messages
// → 轮询拿到 AI 消息 → POST /seen → offline 状态不 typing → reset → Fiona's Class。
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
    focus() {},
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  };
  return e;
}
for (const i of ["chat-list","moment-list","moment-form","moment-input","moment-send","chat-name","chat-state","chat-av",
  "chat-body","chat-bar","chat-input","chat-send","chat-back","chat-call","chat-reset",
  "call","call-av","call-name","call-state","call-said","call-end",
  "call-back","call-list","call-detail-name","call-detail-meta","call-detail-body",
  "auth","auth-form","auth-user","auth-pass","auth-err","auth-reg",
  "view-chats","view-class","view-class-topic","view-calls","view-moments","view-me","view-chat","view-call",
  "class-body","class-back","class-topic-body","class-topic-back","class-topic-call","class-topic-kicker",
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
let lastWs = null;
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { lastWs = this; this.url = url; this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true });
if (!globalThis.crypto?.randomUUID) Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` }, configurable: true });
globalThis.confirm = () => true;

const now = Date.now();
const userPosts = [];
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
  calls.push({ url: u, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
  if (u.includes("assets/contacts")) {
    return u.includes("contact.json")
      ? json({ name: "Leo", status: "", preview: "", time: "", avatar: "a.png",
               base: [10, 60], burst: [0.6, 2], glow: 10, hours: Array(24).fill("active") })
      : text("[]");
  }
  if (u === "/me" || u === "/profile") return json({ user: "riceball" });
  if (u === "/ping" || u === "/away" || u === "/seen" || u === "/reset" || u === "/transcript" || u === "/prefs") return json({ ok: true });
  if (u === "/moments" && (opts?.method || "GET") === "POST") {
    const body = JSON.parse(opts.body);
    userPosts.unshift({ id: `user:${userPosts.length + 1}`, scope: "user", unit: "me",
      kind: "user", text: body.text, published_at: now, reactions: [], liked: false });
    return json({ moment: userPosts[0] });
  }
  if (u === "/moments") return json({ viewer: { name: "riceball", avatar: "me.png" }, moments: [
    ...userPosts,
    { id: "canon:persona-leo:seed-1", scope: "canon", unit: "persona-leo",
      kind: "life", text: "Runner-up today!", published_at: now - 2 * 86400000,
      liked: false, reactions: [
        { id: 1, actor: "persona-leo", kind: "like", text: null, created_at: now - 3600000 },
        { id: 2, actor: "persona-chole", kind: "comment", text: "what beans?", parent_id: null, created_at: now - 1800000 },
      ] },
    { id: "canon:persona-chole:seed-1", scope: "canon", unit: "persona-chole",
      kind: "life", text: "Found a shopping list.", published_at: now - 4 * 86400000,
      liked: false, reactions: [] },
  ] });
  if (u.includes("/moments/") && u.endsWith("/like")) return json({ liked: true });
  if (u.includes("/moments/") && u.endsWith("/comment")) {
    const body = JSON.parse(opts.body);
    return json({ comment: { id: 9, actor: "me", kind: "comment", text: body.text,
      parent_id: null, created_at: now } });
  }
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
  if (u === "/practice/plan") return json({
    intro: "I'm an English teacher. Pick a topic and we'll talk for five minutes.",
    units: [
      {
        id: "unit-01", chapter: "survival", title: "Meet Me", can_do: "Say hello.",
        lesson: {
          scene: "You've just joined a small English meetup.",
          outcomes: ["Introduce yourself", "Say where you're from", "Ask one question back"],
          questions: ["Where are you from originally?", "What do you do?", "What do you do for fun?"],
          phrases: [
            { text: "I'm originally from…", note: "Use it when you live somewhere else now.", example: "I'm from Chengdu." },
            { text: "I work as…", note: "Describe your job in one line.", example: "I work as a designer." },
            { text: "I'm into…", note: "Talk about hobbies you enjoy.", example: "I'm into photography." },
          ],
          challenge: "Answer all three questions without switching to Chinese.",
          prep: "Think of one small detail about your week.",
        },
      },
      {
        id: "unit-07", chapter: "expression", title: "At Work", can_do: "What you do.",
        lesson: {
          scene: "Fiona asks what you actually do all day.",
          outcomes: ["Explain your role", "Describe a workday", "Name one responsibility"],
          questions: ["What do you do all day?", "Who do you work with?", "What are you responsible for?"],
          phrases: [
            { text: "I work on…", note: "Describe your main project.", example: "I work on the mobile app." },
          ],
          challenge: "Explain your job in 40 seconds.",
          prep: "Think of one task a friend outside work would understand.",
        },
      },
    ],
  });
  if (u === "/call-review") return new Promise(() => {});
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
if (chatList.children.length !== 5) throw new Error(`chat rows: ${chatList.children.length}`);
const classRow = chatList.children.find((li) => String(li.children[0]?.className).includes("row--class"));
if (!classRow) throw new Error("Fiona's Class row missing");
if (!calls.some((c) => c.url === "/ping")) throw new Error("boot did not ping presence");
console.log("✓ 列表渲染 5 行（含 Fiona's Class），boot 已 ping");

tabs[2].fire("click");
await tick(30);
if (els.get("view-moments").hidden) throw new Error("moments tab did not open");
const momentList = els.get("moment-list");
if (momentList.children.length !== 2) throw new Error(`moments: ${momentList.children.length}`);
if (momentList.children[0].children[1].children[1].textContent !== "Runner-up today!") {
  throw new Error("moment text missing");
}
console.log("✓ Moments 拉 /moments 并渲染 2 条");

els.get("moment-input").value = "A small thing";
els.get("moment-form").fire("submit");
await tick(30);
if (!calls.some((c) => c.url === "/moments" && c.method === "POST")) throw new Error("moment post missing");
if (momentList.children.length !== 3) throw new Error(`moment post render: ${momentList.children.length}`);
console.log("✓ 发 Moment 后 feed 增加一条");

const first = momentList.children[0];
first.querySelectorAll(".moment__like")[0].fire("click");
await tick(20);
if (!calls.some((c) => c.url.includes("/like") && c.method === "POST")) throw new Error("like missing");
first.querySelectorAll(".moment__act")[0].fire("click");
const reply = first.querySelectorAll(".moment__reply")[0];
if (reply.hidden) throw new Error("reply form did not open");
reply.querySelectorAll(".moment__reply-input")[0].value = "nice";
reply.fire("submit");
await tick(20);
if (!calls.some((c) => c.url.includes("/comment") && c.method === "POST")) throw new Error("comment missing");
console.log("✓ 点赞、评论走 POST /moments/:id");
tabs[0].fire("click");
await tick(20);

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

classRow.children[0].fire("click");
await tick(20);
if (els.get("view-class").hidden) throw new Error("class row did not open class");
if (!els.get("class-body").querySelectorAll(".class-intro").length) throw new Error("class intro missing");
const topicRows = els.get("class-body").querySelectorAll(".class-topic");
if (topicRows.length !== 2) throw new Error(`class topics: ${topicRows.length}`);
console.log("✓ Fiona's Class 行打开课堂，介绍与主题已渲染");

els.get("class-back").fire("click");
await tick(20);
if (!els.get("view-class").hidden) throw new Error("class back did not close class");
console.log("✓ 课堂返回 Chats");

classRow.children[0].fire("click");
await tick(20);
topicRows[0].fire("click");
await tick(20);
if (els.get("view-class-topic").hidden) throw new Error("topic did not open detail");
const topicBody = els.get("class-topic-body");
const topicTitle = topicBody.querySelector(".class-topic-hero__title");
if (!topicTitle || topicTitle.textContent !== "Meet Me") throw new Error("topic title missing");
if (topicBody.dataset.chapter !== "survival") throw new Error("topic chapter missing");
const scene = topicBody.querySelector(".class-topic-hero__scene");
if (!scene || !scene.textContent.includes("English meetup")) throw new Error("topic scene missing");
if (topicBody.querySelectorAll(".class-topic-check").length !== 3) {
  throw new Error("topic outcomes missing");
}
if (topicBody.querySelectorAll(".class-question__no").length !== 3) {
  throw new Error("topic questions missing");
}
if (topicBody.querySelectorAll(".class-phrase").length !== 3) {
  throw new Error("topic phrase cards missing");
}
if (!topicBody.querySelector(".class-topic-challenge")) throw new Error("topic challenge missing");
console.log("✓ 主题卡进入课程详情，场景/目标/提问/表达/挑战已渲染");

els.get("class-topic-back").fire("click");
await tick(20);
if (els.get("view-class").hidden || !els.get("view-class-topic").hidden) {
  throw new Error("detail back did not return to class");
}
console.log("✓ 详情返回课程列表");

topicRows[0].fire("click");
await tick(20);
const fionaBefore = calls.filter((c) => c.url.includes("unit=persona-Fiona")).length;
els.get("class-topic-call").fire("click");
await tick(20);
const classToken = calls.find((c) => c.url === "/token" && c.body?.practice);
if (!classToken || classToken.body.unit !== "unit-01") throw new Error("class token missing");
if (calls.filter((c) => c.url.includes("unit=persona-Fiona")).length !== fionaBefore) {
  throw new Error("class call opened Fiona chat");
}
console.log("✓ 详情页发起课堂通话，不打开 Fiona 聊天");

lastWs.onopen?.();
lastWs.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
lastWs.onmessage?.({ data: JSON.stringify({
  serverContent: { inputTranscription: { text: "hello" }, turnComplete: true },
}) });
await tick(10);
els.get("call-end").fire("click");
await tick(30);
if (els.get("view-call").hidden) throw new Error("class call did not land on Calls detail");
const transcript = calls.find((c) => c.url === "/transcript" && c.body?.practice);
if (!transcript || transcript.body.unit !== "persona-Fiona") throw new Error("class transcript missing");
const pending = els.get("call-detail-body").children[0];
if (!pending || !String(pending.className).includes("review--pending")) {
  throw new Error("pending review is not the first block");
}
if (pending.children[0]?.textContent !== "Review in progress"
  || pending.children[1]?.textContent !== "Fiona is writing your review…") {
  throw new Error("pending review copy missing");
}
console.log("✓ 课堂通话结束落在 Calls 点评页，点评加载卡在最上方");

els.get("call-back").fire("click");
await tick(20);
tabs[0].fire("click");
await tick(20);
const leoRow = chatList.children.find((li) => li !== classRow);
leoRow.children[0].fire("click");
await tick(30);
els.get("chat-call").fire("click");
await tick(20);
const voiceToken = calls.find((c) => c.url === "/token" && !c.body?.practice);
if (!voiceToken) throw new Error("normal call token missing");
lastWs.onopen?.();
lastWs.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
await tick(10);
els.get("call-end").fire("click");
await tick(30);
if (els.get("view-chat").hidden) throw new Error("normal call left chat");
const voiceTranscript = calls.find((c) => c.url === "/transcript" && !c.body?.practice);
if (!voiceTranscript) throw new Error("normal transcript missing");
console.log("✓ 普通语音通话仍留在聊天页，转写不标 practice");
console.log("SMOKE PASS");
process.exit(0);
