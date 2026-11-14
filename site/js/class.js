// Fiona's Class：读 /practice/plan，把 12 个 Unit 当作她课堂里的主题。
const SECTIONS = { survival: "Start here", expression: "For work" };
const LEVELS = { survival: "A2", expression: "B1" };
const STEPS = [
  ["Warm up", "A quick hello and one easy question."],
  ["Talk", "We'll stay on this topic and build a few real answers."],
  ["Wrap up", "One small thing to try next time."],
];

export function initClass({ back, backTopic, showTopic, call }) {
  const body = document.getElementById("class-body");
  const backBtn = document.getElementById("class-back");
  const topicBody = document.getElementById("class-topic-body");
  const topicKicker = document.getElementById("class-topic-kicker");
  const topicBack = document.getElementById("class-topic-back");
  const topicCall = document.getElementById("class-topic-call");
  backBtn?.addEventListener("click", back);
  topicBack?.addEventListener("click", backTopic);
  let loaded = false;
  let topic = null;

  topicCall?.addEventListener("click", () => { if (topic) call(topic.id); });

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
        btn.addEventListener("click", () => openTopic(u));
        topics.append(btn);
      }
    }
    body.append(intro, topics);
  }

  function openTopic(u) {
    topic = u;
    topicKicker.textContent = `Lesson ${lessonNo(u.id)} · ${LEVELS[u.chapter] || "A2"} · 5 min`;
    topicBody.replaceChildren();

    const hero = document.createElement("section");
    hero.className = "class-topic-hero";
    const label = document.createElement("p");
    label.className = "class-topic-hero__label";
    label.textContent = `Lesson ${lessonNo(u.id)} · 1-on-1`;
    const title = document.createElement("h1");
    title.className = "class-topic-hero__title";
    title.textContent = u.title;
    const goal = document.createElement("p");
    goal.className = "class-topic-hero__goal";
    goal.textContent = u.can_do;
    hero.append(label, title, goal);

    const steps = section("What we'll do");
    const list = document.createElement("ol");
    list.className = "class-steps";
    for (const [i, [name, line]] of STEPS.entries()) {
      const li = document.createElement("li");
      const no = document.createElement("span");
      no.className = "class-step__no";
      no.textContent = String(i + 1);
      const wrap = document.createElement("span");
      wrap.className = "class-step__text";
      const b = document.createElement("b");
      b.textContent = name;
      const detail = document.createElement("span");
      detail.textContent = line;
      wrap.append(b, detail);
      li.append(no, wrap);
      list.append(li);
    }
    steps.append(list);

    const phrases = section("Useful phrases");
    const phraseList = document.createElement("ul");
    phraseList.className = "class-phrases";
    for (const phrase of u.phrases || []) {
      const li = document.createElement("li");
      li.textContent = phrase;
      phraseList.append(li);
    }
    phrases.append(phraseList);

    const note = document.createElement("p");
    note.className = "class-topic-note";
    note.textContent = "Before we start, think of one real example. That's all the prep you need.";
    const noteSign = document.createElement("i");
    noteSign.textContent = "— Fiona";
    note.append(document.createElement("br"), noteSign);

    topicBody.append(hero, steps, phrases, note);
    showTopic();
  }

  function section(title) {
    const node = document.createElement("section");
    node.className = "class-topic-section";
    const head = document.createElement("h2");
    head.textContent = title;
    node.append(head);
    return node;
  }

  return { refresh };
}

function lessonNo(id) {
  return String(id).replace("unit-", "");
}
