import { describe, expect, it } from "vitest";
import {
  hasVaultApproval,
  vaultApyAfterFee,
  vaultConvertToAssets,
  vaultConvertToShares,
  vaultNetApy,
  vaultSharePriceE27,
} from "./vault";

const UNIT = 1_000_000n;

describe("vaultNetApy", () => {
  it("is yield net of the vault fee, plus incentives", () => {
    // Smokehouse USDT on 2026-09-22: 6.24% gross, 10% fee, no rewards -> 5.62%.
    expect(vaultNetApy({ baseApy: 0.0624, fee: 0.1, rewardApr: 0 })).toBeCloseTo(0.05616, 6);
  });

  it("does not apply the fee to incentives", () => {
    // Incentives are paid by a third party straight to depositors, so the vault takes no cut.
    const v = { baseApy: 0.04, fee: 0.25, rewardApr: 0.02 };
    expect(vaultNetApy(v)).toBeCloseTo(0.04 * 0.75 + 0.02, 10);
    expect(vaultNetApy(v)).not.toBeCloseTo((0.04 + 0.02) * 0.75, 10);
  });

  it("matches the API's own net figure on real vaults", () => {
    // Steakhouse USDC (Base): 4.50% gross, 25% fee -> API reports 3.36%.
    expect(vaultNetApy({ baseApy: 0.045, fee: 0.25, rewardApr: 0 })).toBeCloseTo(0.0338, 3);
    // Moonwell Flagship USDC (Base): 4.61% gross, 15% fee, 0.13% rewards -> API reports 4.03%.
    expect(vaultNetApy({ baseApy: 0.0461, fee: 0.15, rewardApr: 0.0013 })).toBeCloseTo(0.0405, 3);
  });

  it("separates the after-fee yield from the incentive part", () => {
    expect(vaultApyAfterFee({ baseApy: 0.06, fee: 0.1 })).toBeCloseTo(0.054, 10);
  });

  it("handles a zero-fee vault", () => {
    expect(vaultNetApy({ baseApy: 0.0449, fee: 0, rewardApr: 0 })).toBeCloseTo(0.0449, 10);
  });
});

describe("vault share math", () => {
  it("round-trips assets through shares", () => {
    const totalAssets = 1_000_000n * UNIT;
    const totalShares = 900_000n * UNIT;
    const assets = 12_345n * UNIT;
    const shares = vaultConvertToShares(assets, totalAssets, totalShares);
    // Shares round up, so converting back never comes up short of what was asked for.
    expect(vaultConvertToAssets(shares, totalAssets, totalShares)).toBeGreaterThanOrEqual(assets - 1n);
  });

  it("is empty-safe", () => {
    expect(vaultConvertToAssets(100n, 0n, 0n)).toBe(0n);
    expect(vaultConvertToShares(100n, 0n, 0n)).toBe(0n);
    expect(vaultSharePriceE27(0n, 0n)).toBe(10n ** 27n);
  });

  it("prices shares above 1.0 once a vault has accrued", () => {
    // 1.1 assets per share.
    const price = vaultSharePriceE27(1_100_000n * UNIT, 1_000_000n * UNIT);
    expect(Number(price) / 1e27).toBeCloseTo(1.1, 6);
  });
});

describe("hasVaultApproval", () => {
  it("needs an allowance covering the shares being redeemed", () => {
    expect(hasVaultApproval(100n, 100n)).toBe(true);
    expect(hasVaultApproval(100n, 99n)).toBe(false);
  });

  it("needs nothing when there is no position to exit", () => {
    expect(hasVaultApproval(0n, 0n)).toBe(true);
  });
});
