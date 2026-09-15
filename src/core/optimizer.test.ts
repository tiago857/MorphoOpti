import { describe, expect, it } from "vitest";
import { WAD } from "./math";
import { optimizeAllocation, type OptimizerMarketInput } from "./optimizer";

const YEAR = 31_536_000n;
const USDC = 1_000_000n;

function market(over: Partial<OptimizerMarketInput> & { id: string }): OptimizerMarketInput {
  return {
    totalSupplyAssets: 10_000_000n * USDC,
    totalBorrowAssets: 8_000_000n * USDC,
    feeWad: 0n,
    rateAtTargetWad: (WAD * 4n) / 100n / YEAR, // 4% at target
    rewardApr: 0,
    position: 0n,
    whitelisted: true,
    ...over,
  };
}

function sum(xs: bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

describe("optimizeAllocation", () => {
  it("returns no changes for an empty portfolio", () => {
    const res = optimizeAllocation([market({ id: "a" }), market({ id: "b" })]);
    expect(res.total).toBe(0n);
    expect(res.hasChanges).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/No USDC/);
  });

  it("raises the cap to 1/N and splits evenly across identical markets", () => {
    const T = 300_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "a", position: T }),
      market({ id: "b" }),
      market({ id: "c" }),
    ]);
    expect(res.effectiveCapFraction).toBeCloseTo(1 / 3, 10);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    for (const m of res.markets) {
      expect(Number(m.target) / Number(T)).toBeCloseTo(1 / 3, 2);
    }
    expect(res.hasChanges).toBe(true);
  });

  it("respects the 10% cap with 12 identical markets and spreads to limit own price impact", () => {
    const T = 1_200_000n * USDC;
    const inputs = Array.from({ length: 12 }, (_, i) => market({ id: `m${i}`, position: i === 0 ? T : 0n }));
    const res = optimizeAllocation(inputs);
    expect(res.effectiveCapFraction).toBeCloseTo(0.1, 10);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    const cap = Number(T) * 0.1;
    // m0 currently holds everything, so its external supply is lower and its utilisation higher:
    // it is the best market and should be filled to the cap. The rest split the remainder evenly.
    expect(Number(res.markets[0].target)).toBeCloseTo(cap, -6);
    for (const m of res.markets.slice(1)) {
      expect(Number(m.target)).toBeLessThanOrEqual(cap + 1);
      expect(Number(m.target) / Number(T)).toBeCloseTo(0.9 / 11, 3);
    }
  });

  it("prefers higher-rate markets up to the cap when there are more than 10 markets", () => {
    const T = 1_200_000n * USDC;
    // 12 markets, rate at target from 13% down to 2%.
    const inputs = Array.from({ length: 12 }, (_, i) =>
      market({
        id: `r${13 - i}`,
        position: i === 0 ? T : 0n,
        rateAtTargetWad: (WAD * BigInt(13 - i)) / 100n / YEAR,
      }),
    );
    const res = optimizeAllocation(inputs);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    const targets = res.markets.map((m) => Number(m.target));
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i]).toBeLessThanOrEqual(targets[i - 1] + 1);
    }
    expect(targets[0]).toBeCloseTo(Number(T) * 0.1, -6);
    expect(targets[11]).toBeLessThan(targets[0] / 2);
    // Diversifying out of the single best market costs yield; the cap is a risk constraint, not a yield one.
    expect(res.portfolioApyProjected).toBeLessThan(res.portfolioApyNow);
    expect(res.portfolioApyProjected).toBeGreaterThan(0);
  });

  it("degenerates to equal weights when N <= 10 (cap = 1/N forces it)", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "low", position: T, rateAtTargetWad: (WAD * 2n) / 100n / YEAR }),
      market({ id: "high", rateAtTargetWad: (WAD * 10n) / 100n / YEAR }),
      market({ id: "mid", rateAtTargetWad: (WAD * 5n) / 100n / YEAR }),
    ]);
    for (const m of res.markets) {
      expect(Number(m.target)).toBeCloseTo(Number(T) / 3, -6);
    }
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("models own price impact: a small market gets less than its cap", () => {
    const T = 5_000_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "big", position: T, rateAtTargetWad: (WAD * 5n) / 100n / YEAR }),
      market({
        id: "tiny-hot",
        totalSupplyAssets: 100_000n * USDC,
        totalBorrowAssets: 95_000n * USDC,
        rateAtTargetWad: (WAD * 8n) / 100n / YEAR,
      }),
    ]);
    const tiny = res.markets.find((m) => m.id === "tiny-hot")!;
    // Cap would be 50% = 2.5M, but pouring 2.5M into a 100k market collapses its rate.
    expect(tiny.target).toBeLessThan(tiny.cap);
    expect(tiny.projectedNativeApy).toBeLessThan(tiny.currentNativeApy);
  });

  it("exits non-whitelisted markets completely", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "old", position: T, whitelisted: false }),
      market({ id: "a" }),
      market({ id: "b" }),
    ]);
    const old = res.markets.find((m) => m.id === "old")!;
    expect(old.target).toBe(0n);
    expect(old.delta).toBe(-T);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("cannot withdraw more than available liquidity", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({
        id: "illiquid",
        position: T,
        whitelisted: false,
        totalSupplyAssets: 1_000_000n * USDC,
        totalBorrowAssets: 970_000n * USDC, // only 30k liquidity
      }),
      market({ id: "a" }),
    ]);
    const ill = res.markets.find((m) => m.id === "illiquid")!;
    expect(ill.target).toBe(70_000n * USDC);
    expect(res.warnings.join(" ")).toMatch(/liquidity/);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("drops dust deltas and keeps the sum intact", () => {
    const T = 300_000n * USDC;
    const third = T / 3n;
    const res = optimizeAllocation([
      market({ id: "a", position: third + 400_000n }), // 0.4 USDC over
      market({ id: "b", position: third - 400_000n }),
      market({ id: "c", position: third }),
    ]);
    // Everything is already within dust of the target: no changes.
    expect(res.hasChanges).toBe(false);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("holds pinned markets in place instead of treating them as 0% yield", () => {
    const T = 100_000n * USDC;
    const held = 40_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "unmodellable", position: held, pinned: true }),
      market({ id: "a", position: T - held }),
      market({ id: "b" }),
    ]);
    const pinned = res.markets.find((m) => m.id === "unmodellable")!;
    expect(pinned.target).toBe(held);
    expect(pinned.delta).toBe(0n);
    expect(pinned.pinned).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/non-standard interest rate model/);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    // Cap adjustment ignores the pinned market: 2 allocatable markets -> 50% each.
    expect(res.effectiveCapFraction).toBeCloseTo(0.5, 10);
  });

  it("never routes new capital into a pinned market", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "hot-but-pinned", position: 0n, pinned: true, rateAtTargetWad: (WAD * 50n) / 100n / YEAR }),
      market({ id: "a", position: T }),
      market({ id: "b" }),
    ]);
    expect(res.markets.find((m) => m.id === "hot-but-pinned")!.target).toBe(0n);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("includes diluting reward APR in the objective", () => {
    const T = 1_000_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "plain", position: T }),
      market({ id: "rewarded", rewardApr: 0.05 }),
    ]);
    const rewarded = res.markets.find((m) => m.id === "rewarded")!;
    expect(rewarded.target).toBeGreaterThan(0n);
    expect(rewarded.projectedRewardApr).toBeLessThan(0.05);
    expect(rewarded.projectedRewardApr).toBeGreaterThan(0);
  });
});
