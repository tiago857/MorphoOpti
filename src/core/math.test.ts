import { describe, expect, it } from "vitest";
import {
  RAY,
  WAD,
  sharePriceE27,
  toAssetsDown,
  toSharesDown,
  toSharesUp,
  wTaylorCompounded,
} from "./math";

describe("shares math", () => {
  it("round-trips assets through shares on a fresh market", () => {
    const assets = 1_000_000n; // 1 USDC
    const shares = toSharesDown(assets, 0n, 0n);
    expect(shares).toBe(1_000_000n * 10n ** 6n); // virtual shares scale
    expect(toAssetsDown(shares, 0n, 0n)).toBe(assets);
  });

  it("converts shares to assets with accrued interest", () => {
    // 1000 USDC supplied as 1000e12 shares, then 5% interest accrued.
    const totalShares = 1_000_000_000n * 10n ** 6n;
    const totalAssets = 1_050_000_000n;
    const userShares = totalShares / 10n;
    const assets = toAssetsDown(userShares, totalAssets, totalShares);
    expect(assets).toBeGreaterThanOrEqual(104_999_990n);
    expect(assets).toBeLessThanOrEqual(105_000_000n);
  });

  it("rounds up for toSharesUp", () => {
    expect(toSharesUp(1n, 3n, 10n)).toBeGreaterThanOrEqual(toSharesDown(1n, 3n, 10n));
  });

  it("share price is 1e27 on an empty market", () => {
    expect(sharePriceE27(0n, 0n)).toBe(RAY / 10n ** 6n);
  });
});

describe("wTaylorCompounded", () => {
  it("approximates exp(x) - 1 for small rates", () => {
    const rate = WAD / 31_536_000n / 10n; // ~10% APR per-second
    const growth = wTaylorCompounded(rate, 31_536_000n);
    const exact = Math.exp(0.1) - 1;
    expect(Math.abs(Number(growth) / 1e18 - exact)).toBeLessThan(1e-5);
  });

  it("is zero for zero elapsed time", () => {
    expect(wTaylorCompounded(WAD, 0n)).toBe(0n);
  });
});
