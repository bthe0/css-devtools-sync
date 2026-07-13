import "./global.css.ts";
import { card, fancy } from "./card.css.ts";

const root = document.getElementById("app");
if (!root) throw new Error("#app root element not found");

root.innerHTML = `
  <h1>ve-app dev-sync example</h1>
  <div class="${card}">flat card export (padding/borderRadius/color)</div>
  <div class="${fancy}">fancy export (hover + media nesting)</div>
`;
