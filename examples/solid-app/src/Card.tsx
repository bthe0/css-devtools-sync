import card from "./Card.module.css";

export function Card() {
  return (
    <article class={card.card}>
      <h3 class={card.title}>Rollout status</h3>
      <p>3 of 4 regions synced</p>
    </article>
  );
}

export default Card;
