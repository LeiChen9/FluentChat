import { greeting } from "./greeting.js";
import { initChat } from "./live.js";

const el = document.getElementById("greeting");

const span = (className, text) => {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

const { lead, hook } = greeting();
el.replaceChildren(span("greet__lead", lead), span("greet__hook", hook));

const VIEWS = ["home", "unit", "me", "chat"];

// 对话页是 Unit 的子页面，push 进去后底部仍然亮着 Unit。
// 首页不对应任何 tab，所以它没有选中也正常。
const TAB_OF = { chat: "unit" };

const tabs = [...document.querySelectorAll(".tab")];
const topbar = document.querySelector(".topbar");
const tabbar = document.querySelector(".tabbar");

let current = "home";
// initChat 要引用 showView，showView 又要反过来在离开对话页时调它的 close，
// 所以先给个占位，initChat 跑完再换成真身。两边都是点击时才执行，没影响。
let leaveChat = () => {};

// 对话页有自己的 header，品牌那条要让位。
function showView(name) {
  if (current === "chat" && name !== "chat") leaveChat();
  current = name;

  for (const key of VIEWS) {
    const view = document.getElementById(`view-${key}`);
    const on = key === name;
    view.hidden = !on;
    view.classList.toggle("is-active", on);
  }
  topbar.hidden = name === "chat";
  // 对话页全屏：底部栏也收起来，不然输入框下面还垫一层 safe-area，
  // iPhone 上会多出一条空白。
  tabbar.hidden = name === "chat";

  const tabFor = TAB_OF[name] ?? name;
  for (const tab of tabs) {
    const on = !tab.disabled && tab.dataset.view === tabFor;
    tab.setAttribute("aria-selected", String(on));
  }
}

const chat = initChat({
  show: () => showView("chat"),
  back: () => showView("unit"),
});
leaveChat = () => chat.close();

for (const tab of tabs) {
  if (tab.disabled) continue;
  tab.addEventListener("click", () => showView(tab.dataset.view));
}

document.getElementById("brand").addEventListener("click", () => showView("home"));
