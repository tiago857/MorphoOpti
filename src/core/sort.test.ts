import { describe, expect, it } from "vitest";
import { compareMarkets, DEFAULT_SORT, nextSort, sortMarkets, totalApy, type SortableMarket } from "./sort";

function m(over: Partial<SortableMarket> & { collateralSymbol: string }): SortableMarket {
  return {
    loanSymbol: "USDC",
    lltv: 0.86,
    supplyUsd: 1e6,
    utilization: 0.9,
    apy: 0.05,
    rewardApr: 0,
    ...over,
  };
}

const markets = [
  m({ collateralSymbol: "cbBTC", supplyUsd: 300e6, apy: 0.045, rewardApr: 0 }),
  m({ collateralSymbol: "wstETH", supplyUsd: 50e6, apy: 0.04, rewardApr: 0.062 }),
  m({ collateralSymbol: "PT-USD3", supplyUsd: 10e6, apy: 0.061, rewardApr: 0.0104 }),
  m({ collateralSymbol: "aUSDC", supplyUsd: 1e6, apy: 0.078, rewardApr: 0 }),
];

const names = (list: SortableMarket[]) => list.map((x) => x.collateralSymbol);

describe("sortMarkets", () => {
  it("defaults to the largest markets first", () => {
    expect(names(sortMarkets(markets, DEFAULT_SORT))).toEqual(["cbBTC", "wstETH", "PT-USD3", "aUSDC"]);
  });

  it("sorts by native yield", () => {
    expect(names(sortMarkets(markets, { key: "apy", direction: "desc" }))).toEqual([
      "aUSDC",
      "PT-USD3",
      "cbBTC",
      "wstETH",
    ]);
  });

  it("sorts by total yield, counting rewards", () => {
    // wstETH's 4% + 6.2% rewards beats aUSDC's 7.8% with none.
    expect(names(sortMarkets(markets, { key: "totalApy", direction: "desc" }))).toEqual([
      "wstETH",
      "aUSDC",
      "PT-USD3",
      "cbBTC",
    ]);
  });

  it("reverses on ascending", () => {
    expect(names(sortMarkets(markets, { key: "apy", direction: "asc" }))).toEqual([
      "wstETH",
      "cbBTC",
      "PT-USD3",
      "aUSDC",
    ]);
  });

  it("sorts by name alphabetically", () => {
    expect(names(sortMarkets(markets, { key: "name", direction: "asc" }))).toEqual([
      "aUSDC",
      "cbBTC",
      "PT-USD3",
      "wstETH",
    ]);
  });

  it("breaks ties by market size, largest first, in both directions", () => {
    const tied = [
      m({ collateralSymbol: "small", apy: 0.05, supplyUsd: 1e6 }),
      m({ collateralSymbol: "big", apy: 0.05, supplyUsd: 9e6 }),
    ];
    expect(names(sortMarkets(tied, { key: "apy", direction: "desc" }))).toEqual(["big", "small"]);
    expect(names(sortMarkets(tied, { key: "apy", direction: "asc" }))).toEqual(["big", "small"]);
  });

  it("does not mutate the input array", () => {
    const input = [...markets];
    sortMarkets(input, { key: "apy", direction: "asc" });
    expect(input).toEqual(markets);
  });

  it("keeps a consistent comparator when a value is not finite", () => {
    const withNaN = [m({ collateralSymbol: "ok", apy: 0.05 }), m({ collateralSymbol: "bad", apy: NaN })];
    const sorted = sortMarkets(withNaN, { key: "apy", direction: "desc" });
    expect(names(sorted)).toEqual(["ok", "bad"]);
    expect(compareMarkets(withNaN[0], withNaN[1], { key: "apy", direction: "desc" })).toBeLessThan(0);
  });
});

describe("totalApy", () => {
  it("adds rewards to the native rate", () => {
    expect(totalApy(m({ collateralSymbol: "x", apy: 0.04, rewardApr: 0.01 }))).toBeCloseTo(0.05, 10);
  });
});

describe("nextSort", () => {
  it("starts a new numeric column descending", () => {
    expect(nextSort({ key: "supply", direction: "desc" }, "apy")).toEqual({ key: "apy", direction: "desc" });
  });

  it("starts the name column ascending", () => {
    expect(nextSort({ key: "supply", direction: "desc" }, "name")).toEqual({ key: "name", direction: "asc" });
  });

  it("flips direction when the column is already active", () => {
    expect(nextSort({ key: "apy", direction: "desc" }, "apy")).toEqual({ key: "apy", direction: "asc" });
    expect(nextSort({ key: "apy", direction: "asc" }, "apy")).toEqual({ key: "apy", direction: "desc" });
  });
});
