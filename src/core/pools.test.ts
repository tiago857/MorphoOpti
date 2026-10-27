import { describe, expect, it } from "vitest";
import { WAD } from "./math";
import { optimizePool, splitByLoanAsset, toOptimizerInputs, type PoolSettings } from "./pools";
import type { PortfolioVault } from "../data/vaultOnchain";
import type { MarketParams, Portfolio, PortfolioMarket } from "./types";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USER = "0x1111111111111111111111111111111111111111" as const;
const UNIT = 1_000_000n;
const YEAR = 31_536_000n;

function params(loanToken: string, n: number): MarketParams {
  const addr = `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
  return { loanToken: loanToken as `0x${string}`, collateralToken: addr, oracle: addr, irm: addr, lltv: WAD };
}

function pm(n: number, loanToken: string, symbol: string, position: bigint): PortfolioMarket {
  return {
    id: `0x${n.toString(16).padStart(64, "0")}`,
    params: params(loanToken, n),
    state: {
      totalSupplyAssets: 10_000_000n * UNIT,
      totalSupplyShares: 10_000_000n * UNIT * 10n ** 6n,
      totalBorrowAssets: 8_000_000n * UNIT,
      totalBorrowShares: 8_000_000n * UNIT * 10n ** 6n,
      lastUpdate: 0n,
      fee: 0n,
    },
    rateAtTargetWad: (WAD * 4n) / 100n / YEAR,
    borrowRateWad: 0n,
    rateKnown: true,
    supplyShares: position * 10n ** 6n,
    supplyAssets: position,
    whitelisted: true,
    meta: {
      collateralSymbol: `C${n}`,
      loanSymbol: symbol,
      collateralAddress: params(loanToken, n).collateralToken,
      lltv: 0.86,
      supplyAssetsUsd: 1e7,
      liquidityAssets: 2_000_000n * UNIT,
      apiSupplyApy: 0.04,
      rewards: [],
      rewardApr: 0,
    },
  };
}

function portfolio(markets: PortfolioMarket[]): Portfolio {
  return {
    chainId: 1,
    user: USER,
    markets,
    total: markets.reduce((a, m) => a + m.supplyAssets, 0n),
    isAuthorized: true,
    fetchedAt: 0,
  };
}

const settings: PoolSettings = { defaultCapFraction: 0.1, perMarket: {} };

describe("splitByLoanAsset", () => {
  it("groups markets into one pool per loan asset", () => {
    const pools = splitByLoanAsset(
      portfolio([pm(1, USDC, "USDC", 100n * UNIT), pm(2, USDT, "USDT", 50n * UNIT), pm(3, USDC, "USDC", 0n)]),
    );
    expect(pools).toHaveLength(2);
    const usdc = pools.find((p) => p.symbol === "USDC")!;
    const usdt = pools.find((p) => p.symbol === "USDT")!;
    expect(usdc.markets).toHaveLength(2);
    expect(usdc.total).toBe(100n * UNIT);
    expect(usdt.markets).toHaveLength(1);
    expect(usdt.total).toBe(50n * UNIT);
  });

  it("orders pools by the holdings in them, largest first", () => {
    const pools = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 10n * UNIT), pm(2, USDT, "USDT", 900n * UNIT)]));
    expect(pools.map((p) => p.symbol)).toEqual(["USDT", "USDC"]);
  });

  it("never mixes loan tokens inside a pool", () => {
    const pools = splitByLoanAsset(
      portfolio([pm(1, USDC, "USDC", 1n), pm(2, USDT, "USDT", 1n), pm(3, USDT, "USDT", 1n)]),
    );
    for (const p of pools) {
      for (const m of p.markets) {
        expect(m.params.loanToken.toLowerCase()).toBe(p.loanToken.toLowerCase());
      }
    }
  });

  it("returns no pools for an empty portfolio", () => {
    expect(splitByLoanAsset(portfolio([]))).toEqual([]);
  });
});

describe("optimizePool", () => {
  it("optimizes each pool independently of the others", () => {
    const pools = splitByLoanAsset(
      portfolio([
        pm(1, USDC, "USDC", 1000n * UNIT),
        pm(2, USDC, "USDC", 0n),
        pm(3, USDT, "USDT", 500n * UNIT),
        pm(4, USDT, "USDT", 0n),
      ]),
    );
    for (const p of pools) {
      const res = optimizePool(p, settings);
      // Each pool conserves its own capital; nothing leaks between loan assets.
      expect(res.markets.reduce((a, m) => a + m.target, 0n) + res.unallocated).toBe(p.total);
    }
  });

  it("passes per-market cap and locked overrides through to the optimizer", () => {
    const pools = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT), pm(2, USDC, "USDC", 0n)]));
    const id = pools[0].markets[0].id.toLowerCase();
    const inputs = toOptimizerInputs(pools[0], {
      defaultCapFraction: 0.1,
      perMarket: { [id]: { capFraction: 0.25, locked: 7n * UNIT } },
    });
    const m = inputs.find((i) => i.id.toLowerCase() === id)!;
    expect(m.capFraction).toBe(0.25);
    expect(m.locked).toBe(7n * UNIT);
    expect(inputs.find((i) => i.id.toLowerCase() !== id)!.capFraction).toBeUndefined();
  });

  it("labels warnings with the pool's own symbol", () => {
    const pools = splitByLoanAsset(portfolio([pm(1, USDT, "USDT", 0n)]));
    expect(optimizePool(pools[0], settings).warnings.join(" ")).toMatch(/No USDT supplied/);
  });
});

function vault(over: Partial<PortfolioVault> & { id: string }): PortfolioVault {
  const totalAssets = 10_000_000n * UNIT;
  return {
    kind: "vault",
    name: "Test Vault",
    asset: USDC as `0x${string}`,
    assetSymbol: "USDC",
    shares: 0n,
    supplyAssets: 0n,
    totalAssets,
    totalShares: totalAssets * 10n ** 12n,
    baseApy: 0.05,
    fee: 0.1,
    rewardApr: 0,
    apyAfterFee: 0.045,
    netApy: 0.045,
    totalAssetsUsd: 1e7,
    allowance: 0n,
    // Fully liquid unless a test says otherwise.
    maxWithdraw: over.supplyAssets ?? 0n,
    whitelisted: true,
    ...over,
    id: over.id as `0x${string}`,
  };
}

describe("vaults in a pool", () => {
  it("joins the pool of its underlying asset", () => {
    const pools = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT)]), [
      vault({ id: "0xaaa", supplyAssets: 50n * UNIT, shares: 50n * UNIT }),
    ]);
    expect(pools).toHaveLength(1);
    expect(pools[0].vaults).toHaveLength(1);
    // The pool total counts vault holdings alongside market ones.
    expect(pools[0].total).toBe(150n * UNIT);
  });

  it("forms a pool even with no market on that asset", () => {
    const pools = splitByLoanAsset(portfolio([]), [vault({ id: "0xaaa", supplyAssets: 10n * UNIT })]);
    expect(pools).toHaveLength(1);
    expect(pools[0].symbol).toBe("USDC");
    expect(pools[0].markets).toHaveLength(0);
  });

  it("treats a vault's withdrawal limit as unavailable liquidity", () => {
    // 1000 supplied but the vault can only pay out 200 right now.
    const v = vault({ id: "0xaaa", supplyAssets: 1000n * UNIT, shares: 1000n * UNIT, maxWithdraw: 200n * UNIT });
    const pools = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 0n)]), [v]);
    const inputs = toOptimizerInputs(pools[0], { defaultCapFraction: 0.1, perMarket: {} });
    const vi = inputs.find((i) => i.id === "0xaaa")!;
    // Expressed as "borrowed out", so the optimizer's existing liquidity floor applies unchanged.
    expect(vi.totalSupplyAssets - vi.totalBorrowAssets).toBe(200n * UNIT);
  });

  it("never plans to withdraw more from a vault than it can pay out", () => {
    const v = vault({ id: "0xaaa", supplyAssets: 1000n * UNIT, shares: 1000n * UNIT, maxWithdraw: 200n * UNIT });
    // A market that pays far more, so the optimizer would empty the vault if it could.
    const better = pm(1, USDC, "USDC", 0n);
    better.rateAtTargetWad = (WAD * 30n) / 100n / YEAR;
    const pools = splitByLoanAsset(portfolio([better]), [v]);
    const res = optimizePool(pools[0], { defaultCapFraction: 1, perMarket: {} });
    const row = res.markets.find((m) => m.id === "0xaaa")!;
    // It may withdraw at most the 200 the vault can service, so at least 800 must stay.
    expect(row.target).toBeGreaterThanOrEqual(800n * UNIT);
    // Without the limit it would have emptied the vault into the better-paying market.
    const unlimited = splitByLoanAsset(portfolio([better]), [
      vault({ id: "0xaaa", supplyAssets: 1000n * UNIT, shares: 1000n * UNIT, maxWithdraw: 1000n * UNIT }),
    ]);
    const free = optimizePool(unlimited[0], { defaultCapFraction: 1, perMarket: {} });
    expect(free.markets.find((m) => m.id === "0xaaa")!.target).toBeLessThan(800n * UNIT);
  });

  it("warns when a vault cannot be brought down to its cap", () => {
    // Illiquid vault holding far more than a 10% cap allows: it must stay above cap, and say so.
    const v = vault({ id: "0xaaa", supplyAssets: 900n * UNIT, shares: 900n * UNIT, maxWithdraw: 0n });
    const pools = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT)]), [v]);
    // An explicit 10% cap on the vault: with only two venues the default cap would be switched off.
    const res = optimizePool(pools[0], { defaultCapFraction: 0.1, perMarket: { "0xaaa": { capFraction: 0.1 } } });
    expect(res.markets.find((m) => m.id === "0xaaa")!.issues.join(" ")).toMatch(/cannot be withdrawn right now and must stay/);
    // Nothing is withdrawn from it at all.
    expect(res.markets.find((m) => m.id === "0xaaa")!.target).toBe(900n * UNIT);
  });
});

describe("liquidity gate on new capital", () => {
  const settings: PoolSettings = { defaultCapFraction: 0.5, perMarket: {} };

  function drainedMarket(n: number): PortfolioMarket {
    const m = pm(n, USDC, "USDC", 0n);
    m.state = { ...m.state, totalSupplyAssets: 230_000n * UNIT, totalBorrowAssets: 230_000n * UNIT };
    return m;
  }

  it("explains the block with the exact liquidity figures", () => {
    const [pool] = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT), drainedMarket(2)]));
    const drained = toOptimizerInputs(pool, settings).find((i) => i.id === pool.markets[1].id)!;
    expect(drained.noInflowReason).toMatch(/^0 USDC liquidity available: 100% of the 230,000 USDC supplied is borrowed/);
    const [healthy] = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT)]));
    expect(toOptimizerInputs(healthy, { ...settings, minLiquidity: 10_000_000n * UNIT })[0].noInflowReason).toBe(
      "Only 2,000,000 USDC liquidity available, below your 10,000,000 Min liquidity filter.",
    );
  });

  it("marks a market with no free liquidity as closed to inflows", () => {
    const [pool] = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT), drainedMarket(2)]));
    const inputs = toOptimizerInputs(pool, settings);
    expect(inputs.find((i) => i.id === pool.markets[1].id)!.noInflow).toBe(true);
    expect(inputs.find((i) => i.id === pool.markets[0].id)!.noInflow).toBe(false);
  });

  it("applies the Min liquidity filter as the floor", () => {
    // pm() has $2M free; a $10M floor closes it, a $100k floor does not.
    const [pool] = splitByLoanAsset(portfolio([pm(1, USDC, "USDC", 100n * UNIT)]));
    expect(toOptimizerInputs(pool, { ...settings, minLiquidity: 10_000_000n * UNIT })[0].noInflow).toBe(true);
    expect(toOptimizerInputs(pool, { ...settings, minLiquidity: 100_000n * UNIT })[0].noInflow).toBe(false);
  });
});
