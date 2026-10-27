import { useCallback, useState } from "react";

// Which pools the user wants their idle wallet balance deployed into. Off by default: pulling from the
// wallet needs a token approval, which the rest of the app avoids, so it is always an explicit choice.

const KEY = "morphoopti:idle";

function poolKey(chainId: number, loanToken: string): string {
  return `${chainId}:${loanToken.toLowerCase()}`;
}

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object") return parsed as Record<string, boolean>;
  } catch {
    // ignore corrupt or unavailable storage
  }
  return {};
}

export function useIdleCapital() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(load);

  const isEnabled = useCallback(
    (chainId: number, loanToken: string) => enabled[poolKey(chainId, loanToken)] === true,
    [enabled],
  );

  const toggle = useCallback((chainId: number, loanToken: string) => {
    setEnabled((prev) => {
      const k = poolKey(chainId, loanToken);
      const { [k]: was, ...rest } = prev;
      const next = was ? rest : { ...rest, [k]: true };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // storage unavailable; keep in-memory state only
      }
      return next;
    });
  }, []);

  return { isEnabled, toggle };
}
