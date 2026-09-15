import { describe, expect, it } from "vitest";
import { accrueMarket } from "./accrue";
import { WAD, wMulDown, wTaylorCompounded } from "./math";
import type { MarketState } from "./types";

const base: MarketState = {
  totalSupplyAssets: 1_000_000_000_000n, // 1M USDC
  totalSupplyShares: 1_000_000_000_000n * 10n ** 6n,
  totalBorrowAssets: 800_000_000_000n,
  totalBorrowShares: 800_000_000_000n * 10n ** 6n,
  lastUpdate: 1_000n,
  fee: 0n,
};

const rate = WAD / 31_536_000n / 20n; // 5% per year, per-second WAD

describe("accrueMarket", () => {
  it("does nothing when no time has passed", () => {
    expect(accrueMarket(base, rate, 1_000n)).toEqual(base);
  });

  it("adds interest to both supply and borrow totals without fee", () => {
    const now = 1_000n + 86_400n;
    const out = accrueMarket(base, rate, now);
    const expected = wMulDown(base.totalBorrowAssets, wTaylorCompounded(rate, 86_400n));
    expect(out.totalBorrowAssets - base.totalBorrowAssets).toBe(expected);
    expect(out.totalSupplyAssets - base.totalSupplyAssets).toBe(expected);
    expect(out.totalSupplyShares).toBe(base.totalSupplyShares);
    expect(out.lastUpdate).toBe(now);
  });

  it("mints fee shares when a fee is set", () => {
    const withFee = { ...base, fee: WAD / 10n };
    const out = accrueMarket(withFee, rate, 1_000n + 86_400n);
    expect(out.totalSupplyShares).toBeGreaterThan(base.totalSupplyShares);
    // Fee shares dilute suppliers by ~10% of interest.
    const interest = out.totalSupplyAssets - base.totalSupplyAssets;
    const feeShareValue = ((out.totalSupplyShares - base.totalSupplyShares) * out.totalSupplyAssets) / out.totalSupplyShares;
    expect(Number(feeShareValue) / Number(interest)).toBeCloseTo(0.1, 3);
  });

  it("does nothing when nothing is borrowed", () => {
    const idle = { ...base, totalBorrowAssets: 0n, totalBorrowShares: 0n };
    const out = accrueMarket(idle, rate, 5_000n);
    expect(out.totalSupplyAssets).toBe(idle.totalSupplyAssets);
  });
});
