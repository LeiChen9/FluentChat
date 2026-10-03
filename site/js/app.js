import { greeting } from "./greeting.js";
import { initUnits } from "./live.js";

const el = document.getElementById("greeting");

const span = (className, text) => {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
};

const { lead, hook } = greeting();
el.replaceChildren(span("greet__lead", lead), span("greet__hook", hook));

const tabs = [...document.querySelectorAll(".tab")];

initUnits({});

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    if (tab.getAttribute("aria-selected") === "true") return;
    for (const other of tabs) {
      const on = other === tab;
      other.setAttribute("aria-selected", String(on));
      const view = document.getElementById(`view-${other.dataset.view}`);
      view.hidden = !on;
      view.classList.toggle("is-active", on);
    }
  });
}
