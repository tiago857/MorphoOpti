import { describe, expect, it } from "vitest";
import {
  applyFilters,
  DEFAULT_FILTERS,
  DEFAULT_MIN_LIQUIDITY_USD,
  DEFAULT_MIN_SUPPLY_USD,
  EMPTY_FILTERS,
  isDefaultFilters,
  filterOptions,
  isEmptyFilters,
  matchesFilters,
  toggleValue,
  type FilterableMarket,
  type MarketFilters,
} from "./filters";

function m(over: Partial<FilterableMarket> & { id: string }): FilterableMarket {
  return {
    chainId: 1,
    loanSymbol: "USDC",
    collateralSymbol: "wstETH",
    lltv: 0.86,
    supplyUsd: 1_000_000,
    liquidityUsd: 200_000,
    ...over,
  };
}

function f(over: Partial<MarketFilters> = {}): MarketFilters {
  return { ...EMPTY_FILTERS, ...over };
}

const markets = [
  m({ id: "a", chainId: 1, loanSymbol: "USDC", collateralSymbol: "cbBTC", lltv: 0.86, supplyUsd: 300e6 }),
  m({ id: "b", chainId: 1, loanSymbol: "USDT", collateralSymbol: "wstETH", lltv: 0.915, supplyUsd: 50e6 }),
  m({ id: "c", chainId: 8453, loanSymbol: "USDC", collateralSymbol: "cbBTC", lltv: 0.86, supplyUsd: 10e6 }),
  m({ id: "d", chainId: 1, loanSymbol: "aUSD", collateralSymbol: "PT-USD3", lltv: 0.965, supplyUsd: 1e6, liquidityUsd: 0 }),
];

describe("matchesFilters", () => {
  it("passes everything when no filter is set", () => {
    for (const market of markets) expect(matchesFilters(market, f())).toBe(true);
  });

  it("filters by chain", () => {
    expect(applyFilters(markets, f({ chainIds: [8453] })).map((x) => x.id)).toEqual(["c"]);
  });

  it("filters by loan asset", () => {
    expect(applyFilters(markets, f({ loanSymbols: ["USDT", "aUSD"] })).map((x) => x.id)).toEqual(["b", "d"]);
  });

  it("filters by collateral", () => {
    expect(applyFilters(markets, f({ collateralSymbols: ["cbBTC"] })).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("filters by LLTV, tolerating float noise", () => {
    expect(applyFilters(markets, f({ lltvs: [0.86] })).map((x) => x.id)).toEqual(["a", "c"]);
    // A value reconstructed from WAD arithmetic should still match.
    expect(matchesFilters(m({ id: "x", lltv: 0.8600000000000001 }), f({ lltvs: [0.86] }))).toBe(true);
  });

  it("filters by minimum supply and liquidity", () => {
    expect(applyFilters(markets, f({ minSupplyUsd: 20e6 })).map((x) => x.id)).toEqual(["a", "b"]);
    expect(applyFilters(markets, f({ minLiquidityUsd: 1 })).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("searches collateral, loan symbol and id", () => {
    expect(applyFilters(markets, f({ search: "btc" })).map((x) => x.id)).toEqual(["a", "c"]);
    expect(applyFilters(markets, f({ search: "aUSD" })).map((x) => x.id)).toEqual(["d"]);
    expect(applyFilters(markets, f({ search: "b" })).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("combines filters conjunctively", () => {
    const res = applyFilters(markets, f({ chainIds: [1], loanSymbols: ["USDC"], collateralSymbols: ["cbBTC"] }));
    expect(res.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("filterOptions", () => {
  it("lists the values present, collateral by size and LLTV ascending", () => {
    const opts = filterOptions(markets);
    expect(opts.chainIds).toEqual([1, 8453]);
    expect(opts.loanSymbols).toEqual(["USDC", "USDT", "aUSD"]);
    // cbBTC totals 310M across two markets, so it leads.
    expect(opts.collateralSymbols[0]).toBe("cbBTC");
    expect(opts.lltvs).toEqual([0.86, 0.915, 0.965]);
  });
});

describe("helpers", () => {
  it("recognises an unset filter set", () => {
    expect(isEmptyFilters(f())).toBe(true);
    expect(isEmptyFilters(f({ search: "  " }))).toBe(true);
    expect(isEmptyFilters(f({ minSupplyUsd: 1 }))).toBe(false);
  });

  it("toggles values in and out", () => {
    expect(toggleValue<string>([], "USDC")).toEqual(["USDC"]);
    expect(toggleValue(["USDC", "USDT"], "USDC")).toEqual(["USDT"]);
  });
});

describe("DEFAULT_FILTERS", () => {
  it("hides markets under $100k of size or liquidity by default", () => {
    expect(DEFAULT_MIN_SUPPLY_USD).toBe(100_000);
    expect(DEFAULT_MIN_LIQUIDITY_USD).toBe(100_000);
    expect(DEFAULT_FILTERS.minSupplyUsd).toBe(100_000);
    expect(DEFAULT_FILTERS.minLiquidityUsd).toBe(100_000);
    expect(matchesFilters(m({ id: "dust", supplyUsd: 5, liquidityUsd: 5 }), DEFAULT_FILTERS)).toBe(false);
    // Big but fully borrowed: no free liquidity, so it is hidden too.
    expect(matchesFilters(m({ id: "drained", supplyUsd: 50e6, liquidityUsd: 0 }), DEFAULT_FILTERS)).toBe(false);
    expect(matchesFilters(m({ id: "real", supplyUsd: 250_000, liquidityUsd: 250_000 }), DEFAULT_FILTERS)).toBe(true);
  });

  it("restricts nothing but the two size floors", () => {
    const { minSupplyUsd: _a, minLiquidityUsd: _b, ...rest } = DEFAULT_FILTERS;
    expect(rest).toEqual({ chainIds: [], loanSymbols: [], collateralSymbols: [], lltvs: [], search: "" });
  });

  it("recognises the default as untouched, so Clear filters stays hidden", () => {
    expect(isDefaultFilters(DEFAULT_FILTERS)).toBe(true);
    expect(isDefaultFilters(f({ minSupplyUsd: DEFAULT_MIN_SUPPLY_USD, search: "btc" }))).toBe(false);
    // Dropping the floor to Any is a real change the user made.
    expect(isDefaultFilters(EMPTY_FILTERS)).toBe(false);
  });
});
