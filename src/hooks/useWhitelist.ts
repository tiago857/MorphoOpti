import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";

interface Stored {
  ids: string[];
  initialized: boolean;
}

const key = (chainId: number) => `morphoopti:whitelist:${chainId}`;

function load(chainId: number): Stored {
  try {
    const raw = localStorage.getItem(key(chainId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return { ids: (parsed.ids ?? []).map((s) => s.toLowerCase()), initialized: parsed.initialized ?? true };
    }
  } catch {
    // ignore corrupt storage
  }
  return { ids: [], initialized: false };
}

function save(chainId: number, stored: Stored) {
  try {
    localStorage.setItem(key(chainId), JSON.stringify(stored));
  } catch {
    // storage unavailable; keep in-memory state only
  }
}

/**
 * Per-chain whitelist of market ids persisted in localStorage. On first use for a chain the
 * whitelist is seeded with `defaults` (top markets by size) once they are available.
 */
export function useWhitelist(chainId: number, defaults: Hex[] | undefined) {
  const [stored, setStored] = useState<Stored>(() => load(chainId));

  useEffect(() => {
    setStored(load(chainId));
  }, [chainId]);

  useEffect(() => {
    if (!stored.initialized && defaults && defaults.length > 0) {
      const next = { ids: defaults.map((d) => d.toLowerCase()), initialized: true };
      setStored(next);
      save(chainId, next);
    }
  }, [chainId, defaults, stored.initialized]);

  const update = useCallback(
    (fn: (ids: string[]) => string[]) => {
      setStored((prev) => {
        const next = { ids: Array.from(new Set(fn(prev.ids))), initialized: true };
        save(chainId, next);
        return next;
      });
    },
    [chainId],
  );

  const toggle = useCallback(
    (id: string) => {
      const lower = id.toLowerCase();
      update((ids) => (ids.includes(lower) ? ids.filter((i) => i !== lower) : [...ids, lower]));
    },
    [update],
  );

  const add = useCallback((id: string) => update((ids) => [...ids, id.toLowerCase()]), [update]);
  const remove = useCallback((id: string) => update((ids) => ids.filter((i) => i !== id.toLowerCase())), [update]);
  const reset = useCallback(() => {
    const next = { ids: (defaults ?? []).map((d) => d.toLowerCase()), initialized: true };
    setStored(next);
    save(chainId, next);
  }, [chainId, defaults]);

  const set = useMemo(() => new Set(stored.ids), [stored.ids]);

  return { ids: stored.ids as Hex[], set, toggle, add, remove, reset, initialized: stored.initialized };
}
