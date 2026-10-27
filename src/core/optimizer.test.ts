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

  it("switches the cap off when too few markets are whitelisted", () => {
    const T = 300_000n * USDC;
    const res = optimizeAllocation([market({ id: "a", position: T }), market({ id: "b" }), market({ id: "c" })]);
    expect(res.effectiveCapFraction).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/Only 3 markets whitelisted, fewer than the 10 a 10% cap needs/);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
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

  it("follows yield rather than an even split when too few markets are whitelisted", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "low", position: T, rateAtTargetWad: (WAD * 2n) / 100n / YEAR }),
      market({ id: "high", rateAtTargetWad: (WAD * 10n) / 100n / YEAR }),
      market({ id: "mid", rateAtTargetWad: (WAD * 5n) / 100n / YEAR }),
    ]);
    const t = (id: string) => Number(res.markets.find((m) => m.id === id)!.target);
    // With the cap off, 100k barely moves a $10M market's rate, so it all goes to the best one.
    expect(t("high")).toBe(Number(T));
    expect(t("mid")).toBe(0);
    expect(t("low")).toBe(0);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("puts everything in the only whitelisted market", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([market({ id: "old", position: T, whitelisted: false }), market({ id: "only" })]);
    expect(res.markets.find((m) => m.id === "only")!.target).toBe(T);
    expect(res.unallocated).toBe(0n);
  });

  it("keeps the cap when there are enough markets for it", () => {
    const T = 100_000n * USDC;
    const inputs = Array.from({ length: 12 }, (_, i) => market({ id: `m${i}`, position: i === 0 ? T : 0n }));
    const res = optimizeAllocation(inputs);
    expect(res.effectiveCapFraction).toBe(0.1);
    for (const m of res.markets) expect(Number(m.target)).toBeLessThanOrEqual(Number(T) * 0.1 + 1);
  });

  it("still honours an explicit per-market cap when the default cap is off", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "best", position: T, rateAtTargetWad: (WAD * 10n) / 100n / YEAR, capFraction: 0.3 }),
      market({ id: "other" }),
    ]);
    expect(Number(res.markets.find((m) => m.id === "best")!.target)).toBeLessThanOrEqual(Number(T) * 0.3 + 1);
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
    // The problem is reported on the market itself, with the amount that has to stay.
    expect(ill.issues.join(" ")).toMatch(/liquidity available, so 70,000 of your .* USDC cannot be withdrawn/);
    expect(res.warnings.join(" ")).not.toMatch(/liquidity available/);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("drops dust deltas and keeps the sum intact", () => {
    const T = 300_000n * USDC;
    const third = T / 3n;
    const res = optimizeAllocation([
      market({ id: "a", position: third + 400_000n }), // 0.4 USDC over
      market({ id: "b", position: third - 400_000n }),
      market({ id: "c", position: third }),
    ], { capFraction: 1 / 3 });
    // A 1/3 cap over three markets pins each at a third, and everything is already within dust of it.
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
    expect(pinned.issues.join(" ")).toMatch(/non-standard interest rate model/);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    // The pinned market is not a place to put capital: 2 allocatable markets cannot honour a 10% cap.
    expect(res.effectiveCapFraction).toBe(1);
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

describe("per-market caps and locked capital", () => {
  it("honours a per-market cap override instead of the pool default", () => {
    const T = 1_200_000n * USDC;
    // m1 pays far more than the rest, so the optimizer wants to fill it and its cap is what binds.
    const inputs = Array.from({ length: 12 }, (_, i) =>
      market({
        id: `m${i}`,
        position: i === 0 ? T : 0n,
        rateAtTargetWad: i === 1 ? (WAD * 20n) / 100n / YEAR : (WAD * 4n) / 100n / YEAR,
        capFraction: i === 1 ? 0.3 : undefined,
      }),
    );
    const res = optimizeAllocation(inputs);
    const m1 = res.markets[1];
    // The override lets m1 hold 30% where every other market is still capped at 10%.
    expect(Number(m1.cap)).toBeCloseTo(Number(T) * 0.3, -6);
    expect(Number(m1.target)).toBeGreaterThan(Number(T) * 0.1);
    for (const m of res.markets.filter((m) => m.id !== "m1")) {
      expect(Number(m.target)).toBeLessThanOrEqual(Number(T) * 0.1 + 1);
    }
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("caps an attractive market at the pool default when it has no override", () => {
    const T = 1_200_000n * USDC;
    const inputs = Array.from({ length: 12 }, (_, i) =>
      market({
        id: `m${i}`,
        position: i === 0 ? T : 0n,
        rateAtTargetWad: i === 1 ? (WAD * 20n) / 100n / YEAR : (WAD * 4n) / 100n / YEAR,
      }),
    );
    const res = optimizeAllocation(inputs);
    // Same market, no override: the 10% default now binds instead.
    expect(Number(res.markets[1].target)).toBeLessThanOrEqual(Number(T) * 0.1 + 1);
  });

  it("never withdraws below a locked amount", () => {
    const T = 1_000_000n * USDC;
    const locked = 300_000n * USDC;
    // m0 holds everything; its cap is 10%, but 300k of its position is locked in a loop.
    const inputs = Array.from({ length: 10 }, (_, i) =>
      market({ id: `m${i}`, position: i === 0 ? T : 0n, locked: i === 0 ? locked : undefined }),
    );
    const res = optimizeAllocation(inputs);
    const m0 = res.markets[0];
    expect(m0.target).toBeGreaterThanOrEqual(locked);
    expect(m0.locked).toBe(locked);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
  });

  it("lets locked capital win over the cap and warns", () => {
    const T = 1_000_000n * USDC;
    const locked = 300_000n * USDC; // 30% of the pool, against a 10% cap
    const inputs = Array.from({ length: 10 }, (_, i) =>
      market({ id: `m${i}`, position: i === 0 ? T : 0n, locked: i === 0 ? locked : undefined }),
    );
    const res = optimizeAllocation(inputs);
    const m0 = res.markets[0];
    expect(m0.overCap).toBe(true);
    expect(Number(m0.cap)).toBeGreaterThanOrEqual(Number(locked));
    expect(m0.issues.join(" ")).toMatch(/locked in a loop here, above the .* USDC cap/);
    // Every unlocked market stays within the ordinary cap.
    for (const m of res.markets.slice(1)) {
      expect(m.overCap).toBe(false);
      expect(Number(m.target)).toBeLessThanOrEqual(Number(T) * 0.1 + 1);
    }
  });

  it("clamps a locked amount larger than the actual position", () => {
    const T = 100_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "a", position: T, locked: 10_000_000n * USDC }),
      market({ id: "b" }),
    ]);
    // Locked cannot exceed what is supplied, so it pins the position exactly and nothing moves.
    expect(res.markets[0].locked).toBe(T);
    expect(res.markets[0].target).toBe(T);
    expect(res.hasChanges).toBe(false);
  });

  it("uses the loan-asset symbol in warnings", () => {
    const res = optimizeAllocation([market({ id: "a" })], { symbol: "USDT" });
    expect(res.warnings.join(" ")).toMatch(/No USDT supplied/);
  });
});

describe("degrees of freedom", () => {
  it("warns when the whitelist size times the cap leaves nothing to optimise", () => {
    // 10 markets x 10% cap == 100%: the allocation is fully determined by the constraints.
    const inputs = Array.from({ length: 10 }, (_, i) =>
      market({
        id: `m${i}`,
        position: i === 0 ? 1000n * USDC : 0n,
        rateAtTargetWad: i === 0 ? (WAD * 20n) / 100n / YEAR : (WAD * 3n) / 100n / YEAR,
      }),
    );
    const res = optimizeAllocation(inputs, { capFraction: 0.1 });
    expect(res.warnings.join(" ")).toMatch(/pinned at its cap and yield cannot be optimised/);
    // Yield is irrelevant here: every market lands on the cap regardless of what it pays.
    for (const m of res.markets) {
      expect(Number(m.target) / Number(res.total)).toBeCloseTo(0.1, 3);
    }
  });

  it("does not warn when there is room to choose", () => {
    const inputs = Array.from({ length: 20 }, (_, i) => market({ id: `m${i}`, position: i === 0 ? 1000n * USDC : 0n }));
    const res = optimizeAllocation(inputs, { capFraction: 0.1 });
    expect(res.warnings.join(" ")).not.toMatch(/cannot be optimised/);
  });

  it("puts capital in the best markets when the whitelist is wider than the cap requires", () => {
    // 20 markets, 10% cap: only 10 can be filled, so the five good ones must be chosen.
    const inputs = [
      ...Array.from({ length: 5 }, (_, i) =>
        market({ id: `hi${i}`, position: i === 0 ? 10_000n * USDC : 0n, rateAtTargetWad: (WAD * 20n) / 100n / YEAR }),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        market({ id: `lo${i}`, rateAtTargetWad: (WAD * 3n) / 100n / YEAR }),
      ),
    ];
    const res = optimizeAllocation(inputs, { capFraction: 0.1 });
    const share = (id: string) =>
      Number(res.markets.find((m) => m.id === id)!.target) / Number(res.total);
    for (let i = 0; i < 5; i++) expect(share(`hi${i}`)).toBeCloseTo(0.1, 2);
    // Half the pool sits in the five high-yield markets, all of them at the cap.
    expect([0, 1, 2, 3, 4].reduce((a, i) => a + share(`hi${i}`), 0)).toBeCloseTo(0.5, 2);
  });
});

describe("flat-rate venues (vaults)", () => {
  it("holds its rate no matter how much is allocated", () => {
    const T = 1_000_000n * USDC;
    const res = optimizeAllocation(
      [
        market({ id: "vault", position: T, flatApy: 0.08, totalSupplyAssets: 100_000_000n * USDC }),
        market({ id: "m", position: 0n }),
      ],
      { capFraction: 1 },
    );
    const v = res.markets.find((m) => m.id === "vault")!;
    // A market would sag as size went in; a vault quotes the same rate at any size.
    expect(v.currentApy).toBeCloseTo(0.08, 6);
    expect(v.projectedApy).toBeCloseTo(0.08, 6);
  });

  it("wins the allocation when it simply pays more", () => {
    const T = 1_000_000n * USDC;
    const inputs = [
      market({ id: "vault", position: T, flatApy: 0.12, totalSupplyAssets: 100_000_000n * USDC }),
      ...Array.from({ length: 9 }, (_, i) => market({ id: `m${i}` })),
    ];
    const res = optimizeAllocation(inputs, { capFraction: 0.5 });
    const v = res.markets.find((m) => m.id === "vault")!;
    expect(Number(v.target) / Number(T)).toBeCloseTo(0.5, 2);
  });

  it("still dilutes its reward budget as size goes in", () => {
    // The user holds nothing in the vault yet, so incoming capital is genuinely new money next to
    // the vault's existing 1M of deposits.
    const T = 1_000_000n * USDC;
    const res = optimizeAllocation(
      [
        market({ id: "vault", flatApy: 0.2, rewardApr: 0.1, totalSupplyAssets: 1_000_000n * USDC }),
        market({ id: "m", position: T }),
      ],
      { capFraction: 1 },
    );
    const v = res.markets.find((m) => m.id === "vault")!;
    expect(v.target).toBeGreaterThan(0n);
    // Base rate is untouched, but the fixed reward budget is spread over more capital.
    expect(v.projectedNativeApy).toBeCloseTo(0.2, 6);
    expect(v.projectedRewardApr).toBeLessThan(0.1);
    expect(v.currentRewardApr).toBeCloseTo(0.1, 6);
  });

  it("loses to a market that pays more after the vault's fee", () => {
    const T = 1_000_000n * USDC;
    const inputs = [
      // 6% gross at a 25% fee is 4.5% net, below the market's ~7.8%.
      market({ id: "vault", position: T, flatApy: 0.045, totalSupplyAssets: 100_000_000n * USDC }),
      ...Array.from({ length: 4 }, (_, i) =>
        market({ id: `m${i}`, rateAtTargetWad: (WAD * 8n) / 100n / YEAR }),
      ),
    ];
    const res = optimizeAllocation(inputs, { capFraction: 0.3 });
    const v = res.markets.find((m) => m.id === "vault")!;
    expect(Number(v.target)).toBeLessThan(Number(T) * 0.31);
    expect(res.portfolioApyProjected).toBeGreaterThan(0.045);
  });
});

describe("noInflow markets", () => {
  // A fully borrowed market: its IRM rate is pinned at the top of the curve, so it looks like the
  // best market by far. This is the srRoyUSDC shape: $230k supplied, $230k borrowed, ~57% APY.
  const drained = (over: Partial<OptimizerMarketInput> = {}) =>
    market({
      id: "drained",
      totalSupplyAssets: 230_000n * USDC,
      totalBorrowAssets: 230_000n * USDC,
      rateAtTargetWad: (WAD * 40n) / 100n / YEAR,
      noInflow: true,
      ...over,
    });

  it("never sends new capital into a drained market, however high its APY", () => {
    const T = 1_000_000n * USDC;
    const res = optimizeAllocation([market({ id: "a", position: T }), market({ id: "b" }), drained()]);
    const d = res.markets.find((m) => m.id === "drained")!;
    expect(d.target).toBe(0n);
    expect(sum(res.markets.map((m) => m.target))).toBe(T);
    expect(d.issues.join(" ")).toMatch(/Receives no new USDC even though it is whitelisted/);
    expect(res.warnings.join(" ")).not.toMatch(/whitelisted but/);
  });

  it("still lets an existing position in a drained market be held but not grown", () => {
    const T = 1_000_000n * USDC;
    const pos = 50_000n * USDC;
    const res = optimizeAllocation([
      market({ id: "a", position: T - pos }),
      market({ id: "b" }),
      drained({ position: pos, totalSupplyAssets: 230_000n * USDC + pos }),
    ]);
    const d = res.markets.find((m) => m.id === "drained")!;
    expect(d.target).toBeLessThanOrEqual(pos);
  });

  it("would otherwise chase the spike — the flag is what keeps it out", () => {
    const T = 1_000_000n * USDC;
    const res = optimizeAllocation([market({ id: "a", position: T }), market({ id: "b" }), drained({ noInflow: false })]);
    expect(res.markets.find((m) => m.id === "drained")!.target).toBeGreaterThan(0n);
  });
});

describe("idle wallet capital", () => {
  it("allocates deployed plus idle, with caps sized on the combined total", () => {
    // 1k deployed in one market, 1k idle, 10 identical markets at a 10% cap: each should end at 200,
    // not 100 — the cap is a share of all 2k being allocated.
    const deployed = 1_000n * USDC;
    const idle = 1_000n * USDC;
    const inputs = Array.from({ length: 10 }, (_, i) => market({ id: `m${i}`, position: i === 0 ? deployed : 0n }));
    const res = optimizeAllocation(inputs, { idle });
    expect(res.total).toBe(deployed + idle);
    expect(res.idle).toBe(idle);
    expect(sum(res.markets.map((m) => m.target))).toBe(deployed + idle);
    for (const m of res.markets) expect(Number(m.target) / 1e6).toBeCloseTo(200, 0);
    // Net of all moves, exactly the idle amount comes in from outside.
    expect(sum(res.markets.map((m) => m.delta))).toBe(idle);
    expect(res.unallocated).toBe(0n);
  });

  it("counts idle at 0% in today's APY so now and after compare the same money", () => {
    const deployed = 1_000n * USDC;
    const inputs = [market({ id: "a", position: deployed }), market({ id: "b" })];
    const without = optimizeAllocation(inputs);
    const withIdle = optimizeAllocation(inputs, { idle: deployed });
    expect(withIdle.portfolioApyNow).toBeCloseTo(without.portfolioApyNow / 2, 6);
    expect(withIdle.portfolioApyProjected).toBeGreaterThan(withIdle.portfolioApyNow);
  });

  it("works when nothing is deployed yet", () => {
    const res = optimizeAllocation([market({ id: "a" }), market({ id: "b" })], { idle: 1_000n * USDC });
    expect(sum(res.markets.map((m) => m.target))).toBe(1_000n * USDC);
    expect(res.hasChanges).toBe(true);
  });
});
