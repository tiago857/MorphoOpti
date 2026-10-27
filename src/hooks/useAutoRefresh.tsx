import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export const REFRESH_MS = 60_000;

const KEY = "morphoopti:auto-refresh";

interface AutoRefresh {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

const AutoRefreshContext = createContext<AutoRefresh>({ enabled: true, setEnabled: () => {} });

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Whether market, vault and position queries poll on a timer. Lives above App because App itself
 * calls the data hooks, so the provider has to wrap it rather than sit inside it.
 */
export function AutoRefreshProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(load);
  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // storage unavailable; keep in-memory state only
    }
  }, []);
  const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <AutoRefreshContext.Provider value={value}>{children}</AutoRefreshContext.Provider>;
}

export function useAutoRefresh(): AutoRefresh {
  return useContext(AutoRefreshContext);
}

/** The refetchInterval every polled query uses: the shared period, or false while paused. */
export function useRefreshInterval(): number | false {
  return useAutoRefresh().enabled ? REFRESH_MS : false;
}
