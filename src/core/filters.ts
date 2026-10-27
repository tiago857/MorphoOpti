// Market-list filtering, in the spirit of Morpho's own market browser: narrow by chain, loan asset,
// collateral, LLTV and size. Kept free of API and React types so it can be tested directly.

/** The minimal shape the filters need. The UI maps its rows onto this. */
export interface FilterableMarket {
  id: string;
  chainId: number;
  loanSymbol: string;
  collateralSymbol: string;
  /** Liquidation LTV as a fraction, e.g. 0.86. */
  lltv: number;
  supplyUsd: number;
  liquidityUsd: number;
}

export interface MarketFilters {
  /** Empty means "no restriction" for each of these. */
  chainIds: number[];
  loanSymbols: string[];
  collateralSymbols: string[];
  /** LLTV values as fractions. */
  lltvs: number[];
  minSupplyUsd: number;
  minLiquidityUsd: number;
  /** Free text matched against collateral symbol, loan symbol and market id. */
  search: string;
}

/** No restriction at all. Mostly useful in tests and as the base for the real default. */
export const EMPTY_FILTERS: MarketFilters = {
  chainIds: [],
  loanSymbols: [],
  collateralSymbols: [],
  lltvs: [],
  minSupplyUsd: 0,
  minLiquidityUsd: 0,
  search: "",
};

/**
 * Morpho lists a long tail of near-empty markets that print four-figure APYs on a few dollars of
 * supply. They are noise in every view and unusable in practice, so the list starts with them hidden.
 */
export const DEFAULT_MIN_SUPPLY_USD = 100_000;

/**
 * Size alone is not enough: a large market can be fully borrowed, and one with no free liquidity
 * cannot take a deposit you could later withdraw. Both floors default to the same figure.
 */
export const DEFAULT_MIN_LIQUIDITY_USD = 100_000;

/** What the market list opens with, and what "Clear filters" returns to. */
export const DEFAULT_FILTERS: MarketFilters = {
  ...EMPTY_FILTERS,
  minSupplyUsd: DEFAULT_MIN_SUPPLY_USD,
  minLiquidityUsd: DEFAULT_MIN_LIQUIDITY_USD,
};

/** LLTV values are compared as fractions; tolerate float noise from the WAD conversion. */
const LLTV_EPS = 1e-9;

export function matchesFilters(m: FilterableMarket, f: MarketFilters): boolean {
  if (f.chainIds.length > 0 && !f.chainIds.includes(m.chainId)) return false;
  if (f.loanSymbols.length > 0 && !f.loanSymbols.includes(m.loanSymbol)) return false;
  if (f.collateralSymbols.length > 0 && !f.collateralSymbols.includes(m.collateralSymbol)) return false;
  if (f.lltvs.length > 0 && !f.lltvs.some((l) => Math.abs(l - m.lltv) < LLTV_EPS)) return false;
  if (m.supplyUsd < f.minSupplyUsd) return false;
  if (m.liquidityUsd < f.minLiquidityUsd) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${m.collateralSymbol} ${m.loanSymbol} ${m.id}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function applyFilters<T extends FilterableMarket>(markets: T[], f: MarketFilters): T[] {
  return markets.filter((m) => matchesFilters(m, f));
}

/** True when the filters are untouched from the default, so "Clear filters" has nothing to do. */
export function isDefaultFilters(f: MarketFilters): boolean {
  return (
    f.chainIds.length === 0 &&
    f.loanSymbols.length === 0 &&
    f.collateralSymbols.length === 0 &&
    f.lltvs.length === 0 &&
    f.minSupplyUsd === DEFAULT_FILTERS.minSupplyUsd &&
    f.minLiquidityUsd === DEFAULT_FILTERS.minLiquidityUsd &&
    f.search.trim() === ""
  );
}

export function isEmptyFilters(f: MarketFilters): boolean {
  return (
    f.chainIds.length === 0 &&
    f.loanSymbols.length === 0 &&
    f.collateralSymbols.length === 0 &&
    f.lltvs.length === 0 &&
    f.minSupplyUsd === 0 &&
    f.minLiquidityUsd === 0 &&
    f.search.trim() === ""
  );
}

export interface FilterOptions {
  chainIds: number[];
  loanSymbols: string[];
  collateralSymbols: string[];
  lltvs: number[];
}

/**
 * The values actually present in the data, for populating the filter controls. Collateral symbols are
 * ordered by total size so the meaningful ones come first; LLTVs ascending.
 */
export function filterOptions(markets: FilterableMarket[]): FilterOptions {
  const chainIds = new Set<number>();
  const loanSymbols = new Set<string>();
  const lltvs = new Set<number>();
  const collateralSize = new Map<string, number>();
  for (const m of markets) {
    chainIds.add(m.chainId);
    loanSymbols.add(m.loanSymbol);
    if (Number.isFinite(m.lltv)) lltvs.add(Number(m.lltv.toFixed(6)));
    collateralSize.set(m.collateralSymbol, (collateralSize.get(m.collateralSymbol) ?? 0) + m.supplyUsd);
  }
  return {
    chainIds: Array.from(chainIds).sort((a, b) => a - b),
    loanSymbols: Array.from(loanSymbols).sort(),
    collateralSymbols: Array.from(collateralSize.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s),
    lltvs: Array.from(lltvs).sort((a, b) => a - b),
  };
}

/** Toggle a value in one of the multi-select filter arrays. */
export function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
