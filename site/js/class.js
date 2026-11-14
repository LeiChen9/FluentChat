// Fiona's Class：读 /practice/plan，把 12 个 Unit 当作她课堂里的主题。
const SECTIONS = { survival: "Start here", expression: "For work" };

export function initClass({ open, back }) {
  const body = document.getElementById("class-body");
  const backBtn = document.getElementById("class-back");
  backBtn?.addEventListener("click", back);
  let loaded = false;

  async function refresh() {
    if (loaded) return;
    loaded = true;
    try {
      const res = await fetch("/practice/plan");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      render(data);
    } catch (e) {
      loaded = false;
      body.replaceChildren();
      const p = document.createElement("p");
      p.className = "class-empty";
      p.textContent = `Class unavailable: ${e.message}`;
      body.append(p);
    }
  }

  function render(data) {
    body.replaceChildren();

    const intro = document.createElement("section");
    intro.className = "class-intro";
    const label = document.createElement("p");
    label.className = "class-intro__label";
    label.textContent = "From Fiona";
    const text = document.createElement("p");
    text.className = "class-intro__text";
    text.textContent = data.intro
      || "I'm an English teacher. Pick a topic and we'll talk for five minutes.";
    const sign = document.createElement("p");
    sign.className = "class-intro__sign";
    sign.textContent = "— Fiona";
    intro.append(label, text, sign);

    const topics = document.createElement("div");
    topics.className = "class-topics";
    const units = data.units || [];
    for (const [chapter, title] of Object.entries(SECTIONS)) {
      const group = units.filter((u) => u.chapter === chapter);
      if (!group.length) continue;
      const head = document.createElement("h2");
      head.className = "class-section";
      head.textContent = title;
      topics.append(head);
      for (const u of group) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "class-topic";
        const textWrap = document.createElement("span");
        textWrap.className = "class-topic__text";
        const name = document.createElement("b");
        name.textContent = u.title;
        const line = document.createElement("i");
        line.textContent = u.can_do;
        textWrap.append(name, line);
        const meta = document.createElement("span");
        meta.className = "class-topic__meta";
        meta.textContent = "5 min · voice";
        const chev = document.createElement("span");
        chev.className = "class-topic__chev";
        chev.textContent = "›";
        chev.setAttribute("aria-hidden", "true");
        btn.append(textWrap, meta, chev);
        btn.addEventListener("click", () => open(u.id));
        topics.append(btn);
      }
    }
    body.append(intro, topics);
  }

  return { refresh };
}
