interface Props {
  /** One specific problem per entry. Nothing renders when empty. */
  issues: string[];
}

/**
 * A red warning sign next to a market's name. The details live in the tooltip, so the list stays
 * scannable: the sign says "something is wrong here", hovering says exactly what. It is focusable so
 * the same text is reachable from the keyboard and read out by screen readers.
 */
export function AlertIcon({ issues }: Props) {
  if (issues.length === 0) return null;
  const text = issues.length === 1 ? issues[0] : issues.map((i) => `• ${i}`).join("\n");
  return (
    <span
      className="alert-icon"
      role="img"
      tabIndex={0}
      aria-label={`Warning: ${issues.join(" ")}`}
      title={text}
      onClick={(e) => e.stopPropagation()}
    >
      ⚠
    </span>
  );
}
