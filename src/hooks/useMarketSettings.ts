import { useCallback, useMemo, useState } from "react";

/** Per-market overrides of the pool default. Both fields are optional; absent means "use default". */
export interface MarketSetting {
  /** Max exposure for this market as a percentage of its pool, overriding the default. */
  capPct?: number;
  /**
   * Capital locked in a Morpho loop here, in token units (6 decimals) as a decimal string.
   * The optimizer never withdraws below it.
   */
  lockedUnits?: string;
}

export interface MarketSettings {
  /** Default per-market cap, as a percentage of the pool. */
  defaultCapPct: number;
  /** Keyed by `${chainId}:${marketId}`. */
  markets: Record<string, MarketSetting>;
}

const KEY = "morphoopti:settings";
const DEFAULT_CAP_PCT = 10;

export function settingKey(chainId: number, marketId: string): string {
  return `${chainId}:${marketId.toLowerCase()}`;
}

function load(): MarketSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MarketSettings>;
      const cap = Number(parsed.defaultCapPct);
      return {
        defaultCapPct: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP_PCT,
        markets: parsed.markets && typeof parsed.markets === "object" ? parsed.markets : {},
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return { defaultCapPct: DEFAULT_CAP_PCT, markets: {} };
}

function save(s: MarketSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable; keep in-memory state only
  }
}

/** Parse a user-typed amount ("50,000" / "50000.5") into 6-decimal token units. */
export function parseUnits6(input: string): bigint | undefined {
  const cleaned = input.replace(/[,\s_]/g, "").trim();
  if (cleaned === "") return 0n;
  if (!/^\d*\.?\d*$/.test(cleaned)) return undefined;
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > 6) return undefined;
  return BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/**
 * Per-market cap and locked-capital overrides, persisted in localStorage. The default cap applies to
 * every market without an explicit override.
 */
export function useMarketSettings() {
  const [settings, setSettings] = useState<MarketSettings>(load);

  const mutate = useCallback((fn: (s: MarketSettings) => MarketSettings) => {
    setSettings((prev) => {
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);

  const setDefaultCapPct = useCallback(
    (pct: number) => {
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return;
      mutate((s) => ({ ...s, defaultCapPct: pct }));
    },
    [mutate],
  );

  const setMarket = useCallback(
    (chainId: number, marketId: string, patch: MarketSetting) => {
      mutate((s) => {
        const k = settingKey(chainId, marketId);
        const merged = { ...s.markets[k], ...patch };
        // Drop empty entries so cleared fields fall back to the default rather than pinning it.
        if (merged.capPct === undefined && (merged.lockedUnits === undefined || merged.lockedUnits === "0")) {
          const { [k]: _drop, ...rest } = s.markets;
          return { ...s, markets: rest };
        }
        return { ...s, markets: { ...s.markets, [k]: merged } };
      });
    },
    [mutate],
  );

  const clearMarket = useCallback(
    (chainId: number, marketId: string) => {
      mutate((s) => {
        const { [settingKey(chainId, marketId)]: _drop, ...rest } = s.markets;
        return { ...s, markets: rest };
      });
    },
    [mutate],
  );

  const resetAll = useCallback(() => mutate(() => ({ defaultCapPct: DEFAULT_CAP_PCT, markets: {} })), [mutate]);

  const get = useCallback(
    (chainId: number, marketId: string): MarketSetting | undefined => settings.markets[settingKey(chainId, marketId)],
    [settings.markets],
  );

  const overrideCount = useMemo(() => Object.keys(settings.markets).length, [settings.markets]);

  return { settings, get, setDefaultCapPct, setMarket, clearMarket, resetAll, overrideCount };
}
