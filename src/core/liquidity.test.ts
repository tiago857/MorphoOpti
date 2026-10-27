import { describe, expect, it } from "vitest";
import { describeLiquidity, liquidityLevel, mergeLiquidityIssue } from "./liquidity";

describe("liquidityLevel", () => {
  it("flags a market with nothing left to withdraw", () => {
    expect(liquidityLevel(0, 5_000_000)).toBe("none");
    expect(liquidityLevel(0.4, 5_000_000)).toBe("none");
  });

  it("flags a market at 100% utilization even with a few dollars left", () => {
    // $2k free on $50M supplied is 99.996% utilization.
    expect(liquidityLevel(2_000, 50_000_000)).toBe("none");
  });

  it("flags thin liquidity in absolute terms", () => {
    expect(liquidityLevel(5_000, 20_000)).toBe("low");
  });

  it("flags thin liquidity relative to supply", () => {
    // $500k free on $50M is 99% utilization.
    expect(liquidityLevel(500_000, 50_000_000)).toBe("low");
  });

  it("passes a healthy market", () => {
    expect(liquidityLevel(5_000_000, 50_000_000)).toBe("ok");
  });

  it("treats an empty market with no supply as drained", () => {
    expect(liquidityLevel(0, 0)).toBe("none");
  });

  it("treats a non-number as drained rather than safe", () => {
    expect(liquidityLevel(NaN, 1_000)).toBe("none");
  });
});

describe("describeLiquidity", () => {
  it("names the exact amount and utilization for a drained market", () => {
    const text = describeLiquidity(0, 230_000, "USDC")!;
    expect(text).toMatch(/^0 USDC liquidity available: 100% of the 230,000 USDC supplied is borrowed/);
  });

  it("says how little is left for a thin market", () => {
    expect(describeLiquidity(5_000, 20_000, "USDC")).toMatch(/^Only 5,000 USDC liquidity available \(75% utilized\)/);
  });

  it("is silent for a healthy market", () => {
    expect(describeLiquidity(5_000_000, 50_000_000, "USDC")).toBeUndefined();
  });
});

describe("mergeLiquidityIssue", () => {
  it("leads with the liquidity note when nothing else covers it", () => {
    expect(mergeLiquidityIssue("Only 5 USDC liquidity available.", ["Locked above cap."])).toEqual([
      "Only 5 USDC liquidity available.",
      "Locked above cap.",
    ]);
  });

  it("drops the generic note when an issue already quotes the liquidity", () => {
    const stuck = "Only 0 USDC liquidity available, so 135 of your 135 USDC cannot be withdrawn right now and must stay.";
    expect(mergeLiquidityIssue("0 USDC liquidity available: 100% borrowed.", [stuck])).toEqual([stuck]);
  });
});
