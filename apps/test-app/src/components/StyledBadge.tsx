import { useState } from "react";
import styled from "styled-components";

/**
 * Tier: CSS-in-JS (styled-components), distinct from EmotionButton's
 * @emotion/styled tier. babel-plugin-styled-components is enabled in
 * vite.config.ts with `displayName: true` + `sourceMap: true`, so DevTools
 * shows classes like "StyledBadge__Pill-sc-xxxxx" whose injected <style>
 * carries a sourcemap comment pointing back into this file, letting the sync
 * server locate the tagged template literal below.
 */
const Pill = styled.span<{ tone: "ok" | "warn" }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 120ms ease;

  background-color: ${({ tone }) => (tone === "ok" ? "#065f46" : "#78350f")};
  color: ${({ tone }) => (tone === "ok" ? "#6ee7b7" : "#fcd34d")};
  border: 1px solid ${({ tone }) => (tone === "ok" ? "#10b981" : "#f59e0b")};

  &:hover {
    background-color: ${({ tone }) => (tone === "ok" ? "#047857" : "#92400e")};
  }
`;

const Dot = styled.span`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
`;

export function StyledBadge() {
  const [tone, setTone] = useState<"ok" | "warn">("ok");

  return (
    <Pill tone={tone} onClick={() => setTone((t) => (t === "ok" ? "warn" : "ok"))}>
      <Dot />
      {tone === "ok" ? "All checks passing" : "Degraded — 1 check failing"}
    </Pill>
  );
}
