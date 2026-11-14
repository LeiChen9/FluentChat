// 朋友圈：global canon + 当前用户 overlay；文字、点赞、评论都在这里。
import { loadContacts } from "./personas.js?v=20261114-4";
import { fmtRowTime } from "./live.js?v=20261114-7";

export function initMoments() {
  const list = document.getElementById("moment-list");
  const form = document.getElementById("moment-form");
  const input = document.getElementById("moment-input");
  const send = document.getElementById("moment-send");
  let peoplePromise = null;
  let viewer = { name: "You", avatar: "" };
  let loading = false;

  async function refresh() {
    if (!list || loading) return;
    loading = true;
    try {
      const [res, people] = await Promise.all([
        fetch("/moments", { cache: "no-store" }),
        (peoplePromise ??= loadContacts()).catch(() => []),
      ]);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.viewer) viewer = data.viewer;

      list.replaceChildren();
      const byUnit = new Map((people || []).map((p) => [p.id, p]));
      const rows = Array.isArray(data.moments) ? data.moments : [];
      if (!rows.length) {
        list.append(el("p", "moment-empty", "It's quiet today."));
        return;
      }
      for (const m of rows) list.append(card(m, byUnit));
    } catch {
      list.replaceChildren(el("p", "moment-empty", "Moments are quiet right now."));
    } finally {
      loading = false;
    }
  }

  function author(unit, byUnit) {
    if (unit === "me") return viewer;
    return byUnit.get(unit) || { name: unit, avatar: "" };
  }

  function card(m, byUnit) {
    const p = author(m.unit, byUnit);
    const node = el("article", "moment");
    node.dataset.id = m.id;
    node.dataset.scope = m.scope || "";
    if (m.unit === "me") node.classList.add("moment--mine");
    node.append(avatar(p), body(m, byUnit));
    return node;
  }

  function body(m, byUnit) {
    const box = el("div", "moment__body");
    const head = el("div", "moment__head");
    const who = el("div", "moment__meta");
    const time = el("i", "moment__time", fmtRowTime(m.published_at));
    time.dateTime = new Date(m.published_at).toISOString();
    who.append(el("b", "moment__name", author(m.unit, byUnit).name), time);

    const like = el("button", "moment__like", m.liked ? "♥" : "♡");
    like.type = "button";
    like.setAttribute("aria-label", m.liked ? "Unlike" : "Like");
    like.setAttribute("aria-pressed", String(!!m.liked));
    like.addEventListener("click", async () => {
      try {
        await sendJson(`/moments/${encodeURIComponent(m.id)}/like`, {});
        await refresh();
      } catch {}
    });
    head.append(who, like);

    const reactions = Array.isArray(m.reactions) ? m.reactions : [];
    const likes = reactions
      .filter((r) => r.kind === "like" && r.actor !== "me")
      .map((r) => author(r.actor, byUnit).name);
    const likeLine = likes.length
      ? el("p", "moment__likes", `${likes.slice(0, 2).join(" and ")} liked this`)
      : null;

    const actions = el("div", "moment__actions");
    const toggle = el("button", "moment__act", "Comment");
    toggle.type = "button";
    actions.append(toggle);

    const comments = el("div", "moment__comments");
    for (const r of reactions) {
      if (r.kind !== "comment") continue;
      const row = el("div", "moment__comment");
      row.append(el("b", "", author(r.actor, byUnit).name), el("span", "", r.text));
      comments.append(row);
    }

    const reply = el("form", "moment__reply");
    reply.hidden = true;
    const replyInput = el("input", "moment__reply-input");
    replyInput.type = "text";
    replyInput.placeholder = "Write a comment…";
    replyInput.maxLength = 500;
    const replySend = el("button", "moment__reply-send", "Send");
    replySend.type = "submit";
    reply.append(replyInput, replySend);
    reply.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = replyInput.value.trim();
      if (!text) return;
      replySend.disabled = true;
      try {
        await sendJson(`/moments/${encodeURIComponent(m.id)}/comment`, { text });
        await refresh();
      } catch {
        replySend.disabled = false;
      }
    });
    toggle.addEventListener("click", () => {
      reply.hidden = !reply.hidden;
      if (!reply.hidden) replyInput.focus();
    });

    box.append(head, el("p", "moment__text", m.text));
    if (likeLine) box.append(likeLine);
    box.append(actions, comments, reply);
    return box;
  }

  async function sendJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await sendJson("/moments", { text });
      input.value = "";
      send.disabled = false;
      await refresh();
    } catch {
      send.disabled = false;
    }
  });

  return { refresh };
}

function avatar(p) {
  if (p.avatar) {
    const img = el("img", "moment__av");
    img.src = p.avatar;
    img.alt = "";
    img.loading = "lazy";
    return img;
  }
  return el("span", "moment__av moment__av--letter", (p.name || "?").slice(0, 1).toUpperCase());
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
