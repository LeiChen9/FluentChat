import { initChat, fmtRowTime } from "./live.js?v=20261025-2";
import { loadContacts } from "./personas.js?v=20261024-2";
import { setViewerKey } from "./rhythm.js?v=20261024-3";
import { initCalls } from "./calls.js?v=20261025-1";
// 四个主 tab + 两个子页（聊天 / 通话详情）。
const VIEWS = ["chats", "calls", "moments", "me", "chat", "call"];

// 子页 push 进去后底部仍然亮着所属的 tab。
const TAB_OF = { chat: "chats", call: "calls" };

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
  // 对话/通话详情页全屏：底部栏也收起来，不然输入框下面还垫一层 safe-area，
  // iPhone 上会多出一条空白。
  tabbar.hidden = name === "chat" || name === "call";

  const tabFor = TAB_OF[name] ?? name;
  for (const tab of tabs) {
    const on = tab.dataset.view === tabFor;
    tab.setAttribute("aria-selected", String(on));
  }
  // 每次进 Calls 重画列表（点评可能刚在后台生成完）
  if (name === "calls") calls.refresh();
}

const calls = initCalls({
  show: () => showView("call"),
  back: () => showView("calls"),
});

const chat = initChat({
  show: () => showView("chat"),
  back: () => showView("chats"),
  // Chat 里的通话记录行 → 跳到 Calls 的对应详情
  openCall: (id) => calls.open(id),
});
leaveChat = () => chat.close();

// ── 朋友圈：read 自 contacts 数据目录，代码只做渲染 ──
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
        done(data.user || document.getElementById("auth-user").value.trim());
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

// 登录只挡"云侧"的活（资料、镜像）。本地联系人零网络，先画出来，
// 别让首屏干等一次 /me 往返（1-2 秒白屏）。没登录的话覆盖层随后盖上。
async function boot() {
  loadPeople();
  const status = await me();
  const user = status.user || await showAuth(); // 登录/注册成了才会接资料和云镜
  setViewerKey(user);
  chat.refreshStatuses();
  paintProfile(status.user);
  startHeartbeat();
  chat.prewarmHist();
}

// ── 心跳：页面开着每 3 分钟 /ping 一次报活 ──
// 离开 App 用 /away beacon 立刻标记，回来 /ping 清除；心跳仍是兜底。
function startHeartbeat() {
  // 页面在后台时不报活：否则会把 /away 刚标好的离线状态又清掉
  const beat = () => {
    if (document.visibilityState === "hidden") return;
    fetch("/ping", { method: "POST", keepalive: true }).catch(() => {});
  };
  beat();
  setInterval(beat, 3 * 60_000);
}

// ── 离开/回来信号：切后台、锁屏、关页都算「人不在」──
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    navigator.sendBeacon?.("/away");
  } else {
    fetch("/ping", { method: "POST", keepalive: true }).catch(() => {});
  }
});
window.addEventListener("pagehide", () => { navigator.sendBeacon?.("/away"); });
window.addEventListener("pageshow", () => {
  fetch("/ping", { method: "POST", keepalive: true }).catch(() => {});
});

// ── Me 页个人资料：用户名 + 头像（点行 → 选图 → 压成 128px webp dataURL 上传）──
function paintProfile(name) {
  document.getElementById("me-user").textContent = name;
  fetch("/profile").then((r) => r.json()).then((d) => {
    if (d.user && d.user !== name) document.getElementById("me-user").textContent = d.user;
    const av = document.querySelector("#me-avatar img");
    if (d.avatar) { av.src = d.avatar; av.hidden = false; }
  }).catch(() => {});
}

async function setupProfileUI() {
  const avatar = document.getElementById("me-avatar");
  const fileEl = document.getElementById("avatar-file");
  const errEl = document.getElementById("profile-err");
  // 只有点头像圆圈才开选图器；整行不再绑点击（之前点哪里都弹选图,太吓人）
  avatar.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async () => {
    const file = fileEl.files[0];
    fileEl.value = ""; // 允许重复选同一张图
    if (!file) return;
    errEl.hidden = true;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      const SIDE = 128;
      const crop = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = new OffscreenCanvas(SIDE, SIDE);
      canvas.getContext("2d").drawImage(
        img,
        (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop,
        0, 0, SIDE, SIDE,
      );
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 })
        .catch(() => canvas.convertToBlob({ type: "image/png" }));
      const b64 = await new Promise((done) => {
        const fr = new FileReader();
        fr.onload = () => done(fr.result);
        fr.readAsDataURL(blob);
      });
      const res = await fetch("/avatar", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: b64 }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const av = document.querySelector("#me-avatar img");
      av.src = b64;
      av.hidden = false;
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message || String(e);
    }
  });

  // 登出：清会话 cookie 后整页 reload，boot 会因 /me 空再摆出覆盖层
  document.getElementById("logout-row").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    location.reload();
  });
}
boot();
setupProfileUI();

function loadPeople() {
  const build = (people) => {
    findPersona = (unit) => people.find((p) => p.id === unit) || null;

    const momentList = document.getElementById("moment-list");
    momentList.replaceChildren();
    const moments = people.flatMap((p) => p.moments.map((m) => ({ p, m })))
      .sort((a, b) => new Date(b.m.timestamp) - new Date(a.m.timestamp));
    for (const { p, m } of moments) {
        const card = document.createElement("article");
        card.className = "moment";
        card.innerHTML =
          `<img class="moment__av" src="${p.avatar}" alt="">` +
          `<div class="moment__body">` +
          `<b class="moment__name">${p.name}</b>` +
          `<p class="moment__text"></p>` +
          `<i class="moment__time">${fmtRowTime(m.timestamp)}</i>` +
          `</div>`;
        card.querySelector(".moment__text").textContent = m.text;
        momentList.append(card);
    }
  };

  // 缓存优先：上次建好的整队人马直接开画，冷启动不再盯着空黑屏
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("crowd") || "null"); } catch {}
  if (Array.isArray(cached) && cached.length) build(cached);
  loadContacts().then((people) => {
    try { localStorage.setItem("crowd", JSON.stringify(people)); } catch {}
    build(people); // 网络版追上来为准
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

// 横幅开不开、开什么样式，和 iOS 消息通知一样三档。行点击先出选择层，
// 真正的权限请求推迟到用户选定非 Off 档的那刻（iOS 主屏 web app 的规矩）。
async function ensurePush() {
  setErr("");
  try {
    setNote("Subscribing…");
    const reg = await navigator.serviceWorker.register("sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setNote(perm === "denied" ? "Blocked — enable in Settings" : "Not yet — try again"); return false; }
    let res = await fetch("/push/pubkey");
    if (!res.ok) throw new Error(`pubkey ${res.status} ${(await res.text()).slice(0, 120)}`);
    const key = await res.text();
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
    res = await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subJson) });
    // 先试 JSON（后端错误是 {"error": "..."}），解不出再回退 raw 文本
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = (await res.text()).slice(0, 200); }
      throw new Error(`subscribe ${res.status} ${detail}`);
    }
    return true;
  } catch (e) {
    setErr(`[${new Date().toLocaleTimeString()}] ${e.message}`);
    return false;
  }
}

const notifSheet = document.getElementById("notif-sheet");
pushBtn.addEventListener("click", () => { notifSheet.hidden = false; });
notifSheet.addEventListener("click", async (e) => {
  const opt = e.target.closest("[data-notif]");
  if (!opt) { // 点空白或 Cancel 收层
    if (e.target === notifSheet || e.target.id === "notif-sheet-close") notifSheet.hidden = true;
    return;
  }
  const notif = opt.dataset.notif;
  opt.disabled = true;
  try {
    // 非 Off 档先确保订阅登记了（已在过早就没副作用）；Off 只要服务端记住选择
    if (notif !== "off" && !(await ensurePush())) return;
    const res = await fetch("/prefs", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notif }),
    });
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = `prefs ${res.status}`; }
      throw new Error(detail);
    }
    setNote(notif === "off" ? "Off"
      : notif === "ticker" ? "On — banners without message preview"
      : "On — banners include the message");
    notifSheet.hidden = true;
  } catch (err) {
    setErr(`[${new Date().toLocaleTimeString()}] ${err.message}`);
  } finally {
    opt.disabled = false;
  }
});
// 点击通知后把对应聊天顶上来（sw.js 的 notificationclick postMessage）
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.kind === "open-chat" && e.data.unit) {
    const p = findPersona && findPersona(e.data.unit);
    if (p) chat.open(p);
  }
});

initPushUI();
