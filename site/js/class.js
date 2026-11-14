// Fiona's Class：读 /practice/plan，把 12 个 Unit 当作她课堂里的主题。
const CHAPTERS = {
  survival: { label: "Start here", level: "A2" },
  expression: { label: "For work", level: "B1" },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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
      body.append(el("p", "class-empty", `Class unavailable: ${e.message}`));
    }
  }

  function render(data) {
    body.replaceChildren();

    const intro = el("section", "class-intro");
    intro.append(
      el("p", "class-intro__label", "From Fiona"),
      el("p", "class-intro__text", data.intro
        || "I'm an English teacher. Pick a topic and we'll talk for five minutes."),
      el("p", "class-intro__sign", "— Fiona"),
    );

    const topics = el("div", "class-topics");
    const units = data.units || [];
    for (const [chapter, meta] of Object.entries(CHAPTERS)) {
      const group = units.filter((u) => u.chapter === chapter);
      if (!group.length) continue;
      topics.append(el("h2", "class-section", meta.label));
      for (const u of group) topics.append(topicRow(u));
    }
    body.append(intro, topics);
  }

  function topicRow(u) {
    const btn = el("button", "class-topic");
    btn.type = "button";
    const text = el("span", "class-topic__text");
    text.append(el("b", "", u.title), el("i", "", u.can_do));
    const chev = el("span", "class-topic__chev", "›");
    chev.setAttribute("aria-hidden", "true");
    btn.append(text, el("span", "class-topic__meta", "5 min · voice"), chev);
    btn.addEventListener("click", () => openTopic(u));
    return btn;
  }

  function openTopic(u) {
    topic = u;
    const level = CHAPTERS[u.chapter]?.level || "A2";
    topicKicker.textContent = `Lesson ${lessonNo(u.id)} · ${level} · 5 min`;
    topicBody.replaceChildren();
    topicBody.dataset.chapter = u.chapter || "expression";

    const lesson = u.lesson || {};
    const outcomes = lesson.outcomes || [];
    const questions = lesson.questions || [];
    const phrases = lesson.phrases || [];

    const hero = el("section", "class-topic-hero");
    const meta = el("div", "class-topic-hero__top");
    meta.append(
      el("p", "class-topic-hero__label", "Today's scenario"),
      el("span", "class-topic-hero__badge", `${level} · 5 min`),
    );
    hero.append(
      meta,
      el("h1", "class-topic-hero__title", u.title),
      el("p", "class-topic-hero__scene", lesson.scene || u.can_do),
    );

    if (outcomes.length) {
      const list = el("ul", "class-topic-outcomes");
      for (const outcome of outcomes) {
        const li = el("li");
        const check = el("span", "class-topic-check", "✓");
        check.setAttribute("aria-hidden", "true");
        li.append(check, el("span", "", outcome));
        list.append(li);
      }
      hero.append(el("p", "class-topic-outcomes-label", "By the end, you can"), list);
    }
    topicBody.append(hero);

    if (questions.length) {
      const sec = section("Fiona will ask", "?");
      const list = el("ol", "class-questions");
      for (const [i, question] of questions.entries()) {
        const li = el("li");
        li.append(el("span", "class-question__no", String(i + 1)), el("span", "", question));
        list.append(li);
      }
      sec.append(list);
      topicBody.append(sec);
    }

    if (phrases.length) {
      const sec = section("Phrases to borrow", "“");
      const list = el("div", "class-phrase-list");
      for (const phrase of phrases) {
        const card = el("article", "class-phrase");
        card.append(el("b", "class-phrase__text", phrase.text));
        if (phrase.note) card.append(el("p", "class-phrase__note", phrase.note));
        if (phrase.example) {
          card.append(el("p", "class-phrase__example", `“${phrase.example}”`));
        }
        list.append(card);
      }
      sec.append(list);
      topicBody.append(sec);
    }

    if (lesson.challenge || lesson.prep) {
      const card = el("section", "class-topic-challenge");
      if (lesson.challenge) {
        card.append(
          el("p", "class-topic-challenge__label", "Your 5-minute challenge"),
          el("p", "class-topic-challenge__text", lesson.challenge),
        );
      }
      if (lesson.prep) {
        const prep = el("div", "class-topic-challenge__prep");
        prep.append(el("span", "", "Before you call"), el("p", "", lesson.prep));
        card.append(prep);
      }
      topicBody.append(card);
    }

    showTopic();
  }

  function section(title, mark) {
    const node = el("section", "class-topic-section");
    const head = el("div", "class-topic-section__head");
    const icon = el("span", "class-topic-section__mark", mark);
    icon.setAttribute("aria-hidden", "true");
    head.append(icon, el("h2", "", title));
    node.append(head);
    return node;
  }

  return { refresh };
}

function lessonNo(id) {
  return String(id).replace("unit-", "");
}
