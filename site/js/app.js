import { initChat } from "./live.js";
import { loadContacts } from "./personas.js";
// 四个主 tab + 一个对话子页（对应 line/whatsapp 首层导航）。
const VIEWS = ["chats", "contacts", "moments", "me", "chat"];

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
}

const chat = initChat({
  show: () => showView("chat"),
  back: () => showView("chats"),
});
leaveChat = () => chat.close();

// ── 联系人页 + 朋友圈：read 自 contacts 数据目录，代码只做渲染 ──
loadContacts().then((people) => {
  const contactList = document.getElementById("contact-list");
  for (const p of people) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";
    btn.innerHTML =
      `<img class="row__av" src="${p.avatar}" alt="">` +
      `<span class="row__text"><b>${p.name}</b><i>${p.status}</i></span>`;
    btn.addEventListener("click", () => chat.open(p));
    li.append(btn);
    contactList.append(li);
  }

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

for (const tab of tabs) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}

// ── Web Push 订阅（Me 页按钮）：注册 SW → 授权 → 拿公钥 → 订阅登记 ──
// iOS 备注：16.4+ 要求先「添加到主屏幕」再授权，普通标签页里 requestPermission 不给弹。
const pushBtn = document.getElementById("push-enable");
const pushNote = document.getElementById("push-note");
const setNote = (t) => { pushNote.textContent = t; };

function initPushUI() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setNote("Push not supported here"); pushBtn.disabled = true; return; }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !standalone) { setNote("Add to Home Screen first, then come back"); pushBtn.disabled = true; return; }
  navigator.serviceWorker.register("sw.js").then((reg) => reg.pushManager.getSubscription()).then((sub) => {
    if (sub) setNote("On — good luck out there");
    // 默认文案保留，由用户按下按钮来真开
  }).catch(() => setNote("Push not supported here"));
}

async function enablePush() {
  pushBtn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setNote(perm === "denied" ? "Blocked — enable in Settings" : "Not yet — tap again"); return; }
    const key = await (await fetch("/push/pubkey")).text();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob((key + "=".repeat(4 - (key.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    });
    const res = await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: sub.toJSON() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setNote("On — good luck out there");
  } catch (e) {
    setNote(`Failed: ${e.message}`);
  } finally {
    pushBtn.disabled = false;
  }
}

pushBtn.addEventListener("click", enablePush);
// 点击通知后把对应聊天顶上来（sw.js 的 notificationclick postMessage）
let findPersona = null;
loadContacts().then((people) => {
  findPersona = (unit) => people.find((p) => p.id === unit) || null;
});
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.kind === "open-chat" && e.data.unit) {
    const p = findPersona && findPersona(e.data.unit);
    if (p) chat.open(p);
  }
});

initPushUI();
