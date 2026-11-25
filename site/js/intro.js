const KEY = "fluentchat:intro:v1";

const SLIDES = [
  {
    en: "Chat with your virtual friends.",
    zh: "在日常闲聊里，从磕磕绊绊，到说得流利。",
    art: `<img class="intro__icon" src="assets/FluentChat.png" alt="">`,
  },
  {
    en: "Friends text first.",
    zh: "不用你先开口，他们会主动来找你。",
    art: `<div class="intro__push"><span class="intro__push-app">FluentChat · now</span><b>Leo</b><p>Yo — you around? just saw something weird.</p></div>`,
  },
  {
    en: "Talk, then get a little better.",
    zh: "随便聊，聊完有几句话点评，慢慢就好一点。",
    art: `<div class="intro__talk"><div class="intro__talk-row"><img class="intro__av-lg" src="assets/contacts/sam/avatar.png" alt=""><span><b>Sam</b><i>Voice call · 00:42</i></span></div><div class="intro__review"><p class="intro__review-label">Review notes</p><p class="intro__review-text">Clear and friendly. Try “I take the bus to work” next time.</p></div></div>`,
  },
  {
    en: "Fiona runs a small class.",
    zh: "Fiona 开了个服务号小课堂，想练话题可以去试试。",
    art: `<div class="intro__class"><img class="intro__av-lg" src="assets/contacts/Fiona/avatar.png" alt=""><div class="intro__rows"><span><b>Meet Me</b><i>5 min · voice</i></span><span><b>At Work</b><i>5 min · voice</i></span></div></div>`,
  },
];

export function maybeShowIntro() {
  try { if (localStorage.getItem(KEY)) return Promise.resolve(); } catch {}
  return new Promise((resolve) => {
    const root = document.createElement("section");
    root.className = "intro";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Welcome");
    root.innerHTML = `
      <button class="intro__skip" type="button">Skip</button>
      <div class="intro__body">
        ${SLIDES.map((s, i) => `
          <div class="intro__slide${i === 0 ? " is-active intro__slide--cover" : ""}">
            ${s.art}
            <h2 class="intro__en">${s.en}</h2>
            <p class="intro__zh">${s.zh}</p>
          </div>`).join("")}
      </div>
      <div class="intro__foot">
        <div class="intro__dots" aria-hidden="true">${SLIDES.map((_, i) => `<i class="${i === 0 ? "is-on" : ""}"></i>`).join("")}</div>
        <p class="intro__hint"></p>
      </div>`;
    document.body.append(root);

    let i = 0;
    const slides = [...root.querySelectorAll(".intro__slide")];
    const dots = [...root.querySelectorAll(".intro__dots i")];
    const hint = root.querySelector(".intro__hint");

    const go = (n) => {
      i = n;
      slides.forEach((s, k) => {
        s.classList.toggle("is-active", k === i);
        s.setAttribute("aria-hidden", String(k !== i));
      });
      dots.forEach((d, k) => d.classList.toggle("is-on", k === i));
      hint.textContent = i === SLIDES.length - 1 ? "Tap to start" : "Swipe or tap";
    };
    go(0);

    const finish = () => {
      try { localStorage.setItem(KEY, "1"); } catch {}
      root.remove();
      resolve();
    };
    const next = () => { if (i < SLIDES.length - 1) go(i + 1); else finish(); };
    const prev = () => { if (i > 0) go(i - 1); };

    let swiped = false;
    let x0 = 0;
    root.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    root.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) < 40) return;
      swiped = true;
      setTimeout(() => { swiped = false; }, 400);
      if (dx < 0) next(); else prev();
    });
    root.addEventListener("click", (e) => {
      if (swiped) { swiped = false; return; }
      if (e.target.closest(".intro__skip")) return finish();
      next();
    });
  });
}
