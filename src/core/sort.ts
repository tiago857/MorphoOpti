// Market-list sorting. Kept pure and separate from filtering so the table header can drive it
// directly and the ordering rules stay testable.

export type SortKey = "name" | "lltv" | "supply" | "utilization" | "apy" | "rewards" | "totalApy";
export type SortDirection = "asc" | "desc";

export interface MarketSort {
  key: SortKey;
  direction: SortDirection;
}

/** The shape the sorter needs. The UI maps its rows onto this. */
export interface SortableMarket {
  collateralSymbol: string;
  loanSymbol: string;
  lltv: number;
  supplyUsd: number;
  utilization: number;
  /** Native supply APY as a fraction. */
  apy: number;
  /** Reward APR as a fraction. */
  rewardApr: number;
}

/** Biggest markets first — the same order the Morpho API returns and a sane default. */
export const DEFAULT_SORT: MarketSort = { key: "supply", direction: "desc" };

/** Total yield is what you actually earn: native supply APY plus rewards. */
export function totalApy(m: SortableMarket): number {
  return m.apy + m.rewardApr;
}

function value(m: SortableMarket, key: SortKey): number | string {
  switch (key) {
    case "name":
      return `${m.collateralSymbol} ${m.loanSymbol}`.toLowerCase();
    case "lltv":
      return m.lltv;
    case "supply":
      return m.supplyUsd;
    case "utilization":
      return m.utilization;
    case "apy":
      return m.apy;
    case "rewards":
      return m.rewardApr;
    case "totalApy":
      return totalApy(m);
  }
}

export function compareMarkets(a: SortableMarket, b: SortableMarket, sort: MarketSort): number {
  const av = value(a, sort.key);
  const bv = value(b, sort.key);
  let cmp: number;
  if (typeof av === "string" || typeof bv === "string") {
    cmp = String(av).localeCompare(String(bv));
  } else {
    // NaN would make the comparator inconsistent and corrupt the sort, so treat it as the smallest.
    const an = Number.isFinite(av) ? av : -Infinity;
    const bn = Number.isFinite(bv) ? bv : -Infinity;
    cmp = an === bn ? 0 : an < bn ? -1 : 1;
  }
  if (cmp === 0 && sort.key !== "supply") {
    // Stable, meaningful tie-break: the bigger market first, regardless of direction.
    cmp = a.supplyUsd === b.supplyUsd ? 0 : a.supplyUsd < b.supplyUsd ? 1 : -1;
    return cmp;
  }
  return sort.direction === "asc" ? cmp : -cmp;
}

export function sortMarkets<T extends SortableMarket>(markets: T[], sort: MarketSort): T[] {
  return [...markets].sort((a, b) => compareMarkets(a, b, sort));
}

/**
 * Clicking a column: switch to it (descending, since "most" is what you usually want first), or flip
 * direction when it is already the active column. Name is the exception — A→Z reads better first.
 */
export function nextSort(current: MarketSort, key: SortKey): MarketSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "name" ? "asc" : "desc" };
}
