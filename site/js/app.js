import { initChat } from "./live.js";
import { PERSONAS, MOMENTS } from "./personas.js";

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

// ── 联系人页：persona 名册，点一个进对话 ──
const contactList = document.getElementById("contact-list");
for (const p of PERSONAS) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row";
  btn.innerHTML =
    `<img class="row__av" src="${p.avatar}" alt="">` +
    `<span class="row__text"><b>${p.name}</b><i>${p.tag}</i></span>`;
  btn.addEventListener("click", () => chat.open(p));
  li.append(btn);
  contactList.append(li);
}

// ── 朋友圈：假的动态流，只读 ──
const momentList = document.getElementById("moment-list");
for (const m of MOMENTS) {
  const p = PERSONAS.find((x) => x.id === m.who);
  const card = document.createElement("article");
  card.className = "moment";
  card.innerHTML =
    `<img class="moment__av" src="${p ? p.avatar : ""}" alt="">` +
    `<div class="moment__body">` +
    `<b class="moment__name">${p ? p.name : "?"}</b>` +
    `<p class="moment__text"></p>` +
    `<i class="moment__time">${m.time}</i>` +
    `</div>`;
  card.querySelector(".moment__text").textContent = m.text;
  momentList.append(card);
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showView(tab.dataset.view));
}
