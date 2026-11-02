// Practice tab：读 /practice/plan，按 Ch1 / Ch2 分组渲染场景卡。
const CHAPTERS = { survival: "Ch1 Survival", expression: "Ch2 Expression" };

export function initPractice({ open }) {
  const list = document.getElementById("practice-list");
  let loaded = false;

  async function refresh() {
    if (loaded) return;
    loaded = true;
    try {
      const res = await fetch("/practice/plan");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      render(data.units);
    } catch (e) {
      loaded = false;
      list.replaceChildren();
      const li = document.createElement("li");
      li.className = "call-empty";
      li.textContent = `Practice unavailable: ${e.message}`;
      list.append(li);
    }
  }

  function render(units) {
    list.replaceChildren();
    for (const [key, label] of Object.entries(CHAPTERS)) {
      const group = units.filter((u) => u.chapter === key);
      if (!group.length) continue;
      const head = document.createElement("li");
      head.className = "practice-chapter";
      head.textContent = label;
      list.append(head);
      for (const u of group) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row practice-row";
        btn.innerHTML = `<span class="row__text"><b></b><i></i></span>`;
        btn.querySelector("b").textContent = `${u.id.replace("unit-", "Unit ")} · ${u.title}`;
        btn.querySelector("i").textContent = u.can_do;
        btn.addEventListener("click", () => open(u.id));
        li.append(btn);
        list.append(li);
      }
    }
  }

  return { refresh };
}
