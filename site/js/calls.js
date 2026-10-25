// 通话记录与点评：本机账本 + Calls 列表 + 通话详情。
// live.js 挂断后调 saveCall() 落一条并异步要一份点评；云端不掺和（v1 决定）。
// 点评由 /call-review 一次生成：逐句 better/note + overall + good/improve/focus。

const KEY = "fluentchat:calls:v1";
const MAX = 100;
const state = new Map(); // id -> "loading" | "error"；成功就删
let ui = null;

const clip = (s, n = 56) => (s.length > n ? s.slice(0, n) + "…" : s);

export function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function fmtWhen(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function load() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((r) => r && r.id) : [];
  } catch { return []; }
}

function persist(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, MAX))); } catch {}
}

function persistOne(rec) {
  const arr = load();
  const i = arr.findIndex((r) => r.id === rec.id);
  if (i < 0) return;
  arr[i] = rec;
  persist(arr);
}

// 落一条通话记录（新→旧），顺带异步生成点评。返回记录 id。
export function saveCall(rec) {
  const arr = load();
  arr.unshift(rec);
  persist(arr);
  runReview(rec);
  ui?.changed();
  return rec.id;
}

// 失败重试。
export function retryReview(id) {
  const rec = load().find((r) => r.id === id);
  if (rec) runReview(rec);
}

async function runReview(rec) {
  const turns = (rec.turns || []).map((t) => ({ who: t.who, text: t.text }));
  if (!turns.some((t) => t.who === "me")) return; // 一句没说就不调模型
  state.set(rec.id, "loading");
  ui?.changed();
  try {
    const res = await fetch("/call-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unit: rec.unit, turns }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || typeof data !== "object" || !data.overall) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    rec.review = data;
    state.delete(rec.id);
    persistOne(rec);
  } catch (e) {
    console.warn("call review:", e);
    state.set(rec.id, "error");
  }
  ui?.changed();
}

export function initCalls({ show, back }) {
  const listEl = document.getElementById("call-list");
  const nameEl = document.getElementById("call-detail-name");
  const metaEl = document.getElementById("call-detail-meta");
  const avImg = document.querySelector("#call-detail-av img");
  const bodyEl = document.getElementById("call-detail-body");
  let openId = null;

  const preview = (rec) => {
    if (rec.review?.overall) return rec.review.overall;
    if (state.get(rec.id) === "loading") return "正在生成点评…";
    if (state.get(rec.id) === "error") return "点评生成失败 — 点开可重试";
    if (!(rec.turns || []).some((t) => t.who === "me")) return "No spoken lines";
    return "No review yet";
  };

  function renderList() {
    const arr = load();
    listEl.replaceChildren();
    if (!arr.length) {
      const li = document.createElement("li");
      li.className = "call-empty";
      li.textContent = "No calls yet — tap the phone in a chat to call a friend.";
      listEl.append(li);
      return;
    }
    for (const rec of arr) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row";
      btn.innerHTML =
        `<img class="row__av" alt="">` +
        `<span class="row__text"><b></b><i></i></span>` +
        `<span class="row__time"></span>`;
      btn.querySelector(".row__av").src = rec.avatar || "";
      btn.querySelector("b").textContent = rec.name || rec.unit;
      btn.querySelector("i").textContent = `${fmtDur(rec.dur)} · ${clip(preview(rec))}`;
      btn.querySelector(".row__time").textContent = fmtWhen(rec.start);
      btn.addEventListener("click", () => open(rec.id, true));
      li.append(btn);
      listEl.append(li);
    }
  }

  function tip(l) {
    const box = document.createElement("div");
    box.className = "tip";
    const better = document.createElement("p");
    better.className = "tip__better";
    better.textContent = l.better;
    const note = document.createElement("p");
    note.className = "tip__note";
    note.textContent = l.note || "可以更自然一点。";
    box.append(better, note);
    return box;
  }

  function section(title, items) {
    if (!items || !items.length) return null;
    const box = document.createElement("div");
    box.className = "review__sec";
    const b = document.createElement("b");
    b.textContent = title;
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.append(li);
    }
    box.append(b, ul);
    return box;
  }

  function renderDetail(rec) {
    nameEl.textContent = rec.name || rec.unit;
    metaEl.textContent = `${fmtWhen(rec.start)} · ${fmtDur(rec.dur)}`;
    avImg.src = rec.avatar || "";
    bodyEl.replaceChildren();

    const hasMe = (rec.turns || []).some((t) => t.who === "me");
    if (rec.review) {
      const legend = document.createElement("p");
      legend.className = "call-legend";
      legend.textContent = "Lines without a note already sound natural.";
      bodyEl.append(legend);
    }

    const lines = new Map(((rec.review?.lines) || []).map((l) => [l.i, l]));
    (rec.turns || []).forEach((t, i) => {
      const node = document.createElement("p");
      node.className = `msg msg--${t.who === "me" ? "me" : "ai"}`;
      node.textContent = t.text;
      bodyEl.append(node);
      const l = t.who === "me" ? lines.get(i) : null;
      if (l) bodyEl.append(tip(l));
    });

    if (rec.review) {
      const card = document.createElement("div");
      card.className = "review";
      const label = document.createElement("p");
      label.className = "review__label";
      label.textContent = "Summary";
      const overall = document.createElement("p");
      overall.className = "review__text";
      overall.textContent = rec.review.overall || "";
      card.append(label, overall);
      for (const [title, items] of [
        ["做得好的", rec.review.good],
        ["可改进的", rec.review.improve],
        ["重点练什么", rec.review.focus],
      ]) {
        const sec = section(title, items);
        if (sec) card.append(sec);
      }
      bodyEl.append(card);
    } else {
      const st = state.get(rec.id);
      const note = document.createElement("p");
      note.className = "call-note";
      note.textContent = !hasMe ? "这次通话没有你的发言，所以没有点评。"
        : st === "loading" ? "正在生成点评…"
        : st === "error" ? "点评生成失败。"
        : "这次通话还没有点评。";
      bodyEl.append(note);
      if (hasMe && st !== "loading") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "call-retry";
        btn.textContent = st === "error" ? "重试" : "生成点评";
        btn.addEventListener("click", () => retryReview(rec.id));
        bodyEl.append(btn);
      }
    }
    bodyEl.scrollTop = 0;
  }

  function open(id, go) {
    const rec = load().find((r) => r.id === id);
    if (!rec) return;
    openId = id;
    renderDetail(rec);
    if (go) show();
  }

  ui = {
    changed() {
      renderList();
      if (!openId) return;
      const rec = load().find((r) => r.id === openId);
      if (rec) renderDetail(rec);
    },
  };

  document.getElementById("call-back").addEventListener("click", () => {
    openId = null;
    back();
  });
  renderList();

  return {
    open: (id) => open(id, true),
    refresh: renderList,
  };
}
