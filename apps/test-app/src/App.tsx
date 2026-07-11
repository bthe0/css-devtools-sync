import { PlainCard } from "./components/PlainCard";
import { ModuleCard } from "./components/ModuleCard";
import { ScssPanel } from "./components/ScssPanel";
import { EmotionButton } from "./components/EmotionButton";
import { StyledBadge } from "./components/StyledBadge";
import { TailwindHero } from "./components/TailwindHero";
import { StaticBlock } from "./components/StaticBlock";
import { DynamicGreeting } from "./components/DynamicGreeting";
import { ImageBlock } from "./components/ImageBlock";

export function App() {
  return (
    <main className="app-shell">
      <h1 className="app-title">css-devtools-sync test app</h1>
      <p className="app-subtitle">
        Seven components, seven sync tiers. Edit any of them in DevTools,
        click Sync in the extension panel, and the matching source file
        changes.
      </p>
      <section className="tier-section" id="plain">
        <h2 className="tier-heading">ZZZ</h2>
        <PlainCard />
      </section>
      <section className="tier-section" id="module">
        <h2 className="tier-heading">
          Tier: CSS Modules (hashed selector demangle) — ModuleCard.module.css
        </h2>
        <ModuleCard />
      </section>
      <section className="tier-section" id="scss">
        <h2 className="tier-heading">
          Tier: Sass module (sourcemap) — ScssPanel.module.scss
        </h2>
        <ScssPanel />
      </section>
      <section className="tier-section" id="emotion">
        <h2 className="tier-heading">
          Tier: CSS-in-JS (Emotion) — EmotionButton.tsx
        </h2>
        <EmotionButton />
      </section>
      <section className="tier-section" id="styled-components">
        <h2 className="tier-heading">Tier: CSS-in-JS (styled-components) — StyledBadge.tsx</h2>
        <StyledBadge />
      </section>
      <section className="tier-section" id="tailwind">
        <h2 className="tier-heading">
          Tier: class list (Tailwind) — TailwindHero.tsx
        </h2>
        <TailwindHero />
      </section>
      <section className="tier-section" id="static">
        <h2 className="tier-heading">
          Tier: DOM/HTML template — StaticBlock.tsx
        </h2>
        <StaticBlock />
      </section>
      <section className="tier-section" id="dynamic-text">
        <h2 className="tier-heading">
          Tier: dynamic text (describe + set-text-segment) — DynamicGreeting.tsx
        </h2>
        <DynamicGreeting name="Ada" count={3} />
      </section>
      <section className="tier-section" id="image">
        <h2 className="tier-heading">
          Tier: image rescale (width/height set-attr) — ImageBlock.tsx
        </h2>
        <ImageBlock />
      </section>
    </main>
  );
}
