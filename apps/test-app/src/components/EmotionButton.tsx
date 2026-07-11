import { useState } from "react";
import styled from "@emotion/styled";

/**
 * Tier: CSS-in-JS (@emotion/styled).
 * Styles live in THIS file as template literals. @emotion/babel-plugin is
 * configured with sourceMap + autoLabel, so DevTools shows classes like
 * "css-...--StyledButton" whose injected <style> maps back to these lines.
 */
const Wrap = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const StyledButton = styled.button<{ variant: "primary" | "ghost" }>`
  font-size: 14px;
  font-weight: 600;
  padding: 10px 22px;
  border-radius: 8px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    transform 80ms ease;

  background-color: ${({ variant }) =>
    variant === "primary" ? "#e11d48" : "transparent"};
  color: ${({ variant }) => (variant === "primary" ? "#ffffff" : "#fda4af")};
  border: ${({ variant }) =>
    variant === "primary" ? "1px solid #e11d48" : "1px solid #4c1d2e"};

  &:hover {
    background-color: ${({ variant }) =>
      variant === "primary" ? "#be123c" : "rgba(225, 29, 72, 0.12)"};
  }

  &:active {
    transform: scale(0.97);
  }
`;

const ClickCount = styled.span`
  font-size: 13px;
  color: #8b90a0;
  font-variant-numeric: tabular-nums;
`;

export function EmotionButton() {
  const [clicks, setClicks] = useState(0);

  return (
    <Wrap>
      <StyledButton variant="primary" onClick={() => setClicks((c) => c + 1)}>
        Trigger deploy
      </StyledButton>
      <StyledButton variant="ghost" onClick={() => setClicks(0)}>
        Reset
      </StyledButton>
      <ClickCount>
        {clicks === 0 ? "not clicked yet" : `${clicks} click${clicks === 1 ? "" : "s"}`}
      </ClickCount>
    </Wrap>
  );
}
