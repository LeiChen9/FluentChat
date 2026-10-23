import { initChat } from "./live.js";
import { loadContacts } from "./personas.js";
import { statusOf } from "./rhythm.js";
// 四个主 tab + 一个对话子页（对应 line/whatsapp 首层导航）。
const VIEWS = ["chats", "contacts", "moments", "me", "chat"];

// Contacts 状态副标题跟 rhythm 的档位走：点颜色和文案一一对应
const STATUS_LABEL = { active: "Active", away: "Away", busy: "Busy", offline: "Offline" };
let paintStatus = null;

// 对话页是聊天列表的子页面，push 进去后底部仍然亮着聊天。
const TAB_OF = { chat: "chats" };

const tabs = [...document.querySelectorAll(".tab")];
const tabbar = document.querySelector(".tabbar");

let current = "chats";
// initChat 要引用 showView，showView 又要反过来在离开对话页时调它的 close，
// 所以先给个占位，initChat 跑完再换成真身。两边都是点击时才执行，没影响。
let leaveChat = () => {};

function showView(name) {
  if (current === "chat" && name !== "chat") leaveChat();
  current = name;

  for (const key of VIEWS) {
    const view = document.getElementById(`view-${key}`);
    const on = key === name;
    view.hidden = !on;
    view.classList.toggle("is-active", on);
  }
  // 对话页全屏：底部栏也收起来，不然输入框下面还垫一层 safe-area，
  // iPhone 上会多出一条空白。
  tabbar.hidden = name === "chat";

  const tabFor = TAB_OF[name] ?? name;
  for (const tab of tabs) {
    const on = tab.dataset.view === tabFor;
    tab.setAttribute("aria-selected", String(on));
  }
  // 每次进 Contacts 重算状态点（rhythm 的状态每 2 分钟漂移，不能只画一次）
  if (name === "contacts") paintStatus?.();
}

const chat = initChat({
  show: () => showView("chat"),
  back: () => showView("chats"),
});
leaveChat = () => chat.close();

// ── 联系人页 + 朋友圈：read 自 contacts 数据目录，代码只做渲染 ──
let findPersona = null;

// ── 认证：/me 查 cookie 会话；没登录先在覆盖层上完成登录/注册，再接着装数据 ──
async function me() {
  try { return await (await fetch("/me")).json(); } catch { return {}; }
}

function showAuth() {
  return new Promise((done) => { // 登录/注册成功才 resolve，boot 才往下走
    const box = document.getElementById("auth");
    const err = document.getElementById("auth-err");
    const loginBtn = box.querySelector(".auth__primary");
    const busy = (on) => { loginBtn.disabled = document.getElementById("auth-reg").disabled = on; };

    const go = async (kind) => {
      err.textContent = "……"; // 请求在途先给个动静：R2 读写要 1-2 秒，别让人以为死了
      busy(true);
      try {
        const res = await fetch(`/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("auth-user").value.trim(),
            password: document.getElementById("auth-pass").value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = data.error || `HTTP ${res.status}`; return; }
        box.hidden = true; // 成功：覆盖层撤走
        done();
      } catch {
        err.textContent = "Network issue — try again";
      } finally {
        busy(false);
      }
    };
    document.getElementById("auth-form").addEventListener("submit", (e) => { e.preventDefault(); go("login"); });
    document.getElementById("auth-reg").addEventListener("click", () => go("register"));

    box.hidden = false;
    go("login"); // 自动登录已有会话的人：成了覆盖层自己退场
  });
}

// 登录挡住一切数据装载：聊天列表、联系人、朋友圈都要会话才有意义。
async function boot() {
  const status = await me();
  if (!status.user) await showAuth(); // 登录/注册成了才会往下走
  loadPeople();
}
boot();

function loadPeople() {
  loadContacts().then((people) => {
  findPersona = (unit) => people.find((p) => p.id === unit) || null;
  const contactList = document.getElementById("contact-list");
  const statusBits = [];
  for (const p of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";
    btn.innerHTML =
      `<img class="row__av" src="${p.avatar}" alt="">` +
      `<span class="row__text"><b>${p.name}</b><i class="row__status"><span class="dot"></span><span class="st-label"></span></i></span>`;
    btn.addEventListener("click", () => chat.open(p));
    li.append(btn);
    contactList.append(li);
    statusBits.push({ p, dot: btn.querySelector(".dot"), label: btn.querySelector(".st-label") });
  }

  // 状态随时段漂移（active/away/busy/offline → 绿/黄/红/灰），进 tab 时刷
  paintStatus = () => {
    for (const b of statusBits) {
      const st = statusOf(b.p, new Date());
      b.dot.className = `dot dot--${st}`;
      b.label.textContent = STATUS_LABEL[st];
    }
  };
  paintStatus();

  const momentList = document.getElementById("moment-list");
  for (const p of people) {
    for (const m of p.moments) {
      const card = document.createElement("article");
      card.className = "moment";
      card.innerHTML =
        `<img class="moment__av" src="${p.avatar}" alt="">` +
        `<div class="moment__body">` +
        `<b class="moment__name">${p.name}</b>` +
        `<p class="moment__text"></p>` +
        `<i class="moment__time">${m.time}</i>` +
        `</div>`;
      card.querySelector(".moment__text").textContent = m.text;
      momentList.append(card);
    }
  }
});
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}

// ── Web Push 订阅（Me 页按钮）：注册 SW → 授权 → 拿公钥 → 订阅登记 ──
// iOS 备注：16.4+ 要求先「添加到主屏幕」再授权，普通标签页里 requestPermission 不给弹。
const pushBtn = document.getElementById("push-enable");
const pushNote = document.getElementById("push-note");
const pushErr = document.getElementById("push-err");
const setNote = (t) => { pushNote.textContent = t; };
const setErr = (t) => {
  if (!t) { pushErr.hidden = true; return; }
  pushErr.hidden = false;
  pushErr.textContent = t;
};

function initPushUI() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setNote("Push not supported here"); pushBtn.disabled = true; return; }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !standalone) { setNote("Add to Home Screen first, then come back"); pushBtn.disabled = true; return; }
  navigator.serviceWorker.register("sw.js").then((reg) => reg.pushManager.getSubscription()).then((sub) => {
    if (sub) setNote("Subscribed before — tap to re-sync with server");
    // 无订阅时默认文案保留，由用户按下按钮来真开
  }).catch(() => setNote("Push not supported here"));
}

async function enablePush() {
  pushBtn.disabled = true;
  setErr("");
  try {
    setNote("Checking permission…");
    const reg = await navigator.serviceWorker.register("sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setNote(perm === "denied" ? "Blocked — enable in Settings" : "Not yet — tap again"); return; }
    setNote("Getting server key…");
    let res = await fetch("/push/pubkey");
    if (!res.ok) throw new Error(`pubkey ${res.status} ${(await res.text()).slice(0, 120)}`);
    const key = await res.text();
    setNote("Subscribing…");
    const applicationServerKey = Uint8Array.from(
      atob((key + "=".repeat(4 - (key.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const currentKey = sub.options.applicationServerKey;
      const sameKey = currentKey && new Uint8Array(currentKey).every(
        (byte, i) => byte === applicationServerKey[i],
      ) && currentKey.byteLength === applicationServerKey.byteLength;
      if (!sameKey) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    // Safari 某些版本 sub.toJSON() 缺失/返回 undefined，显式 stringify + 手工兜底
    const b64u = (ab) => btoa(String.fromCharCode(...new Uint8Array(ab))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const json = sub.toJSON?.();
    const subJson = (json && Object.keys(json).length)
      ? json
      : { endpoint: sub.endpoint, keys: { p256dh: b64u(sub.getKey("p256dh")), auth: b64u(sub.getKey("auth")) } };
    setNote("Registering with server…");
    res = await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subJson) });
    // 先试 JSON（后端错误是 {"error": "..."}），解不出再回退 raw 文本
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = (await res.text()).slice(0, 200); }
      throw new Error(`subscribe ${res.status} ${detail}`);
    }
    setNote("On — synced with server");
  } catch (e) {
    setNote("Something failed — see details below");
    setErr(`[${new Date().toLocaleTimeString()}] ${e.message}`);
  } finally {
    pushBtn.disabled = false;
  }
}

pushBtn.addEventListener("click", enablePush);
// 点击通知后把对应聊天顶上来（sw.js 的 notificationclick postMessage）
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.kind === "open-chat" && e.data.unit) {
    const p = findPersona && findPersona(e.data.unit);
    if (p) chat.open(p);
  }
});

initPushUI();
