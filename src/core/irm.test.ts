import { describe, expect, it } from "vitest";
import { borrowApy, curve, supplyApy, utilization } from "./irm";
import { SECONDS_PER_YEAR } from "./math";

describe("adaptive curve", () => {
  it("is 0.25x at zero utilisation, 1x at target, 4x at full", () => {
    expect(curve(0)).toBeCloseTo(0.25, 10);
    expect(curve(0.9)).toBeCloseTo(1, 10);
    expect(curve(1)).toBeCloseTo(4, 10);
  });

  it("is monotonically increasing and continuous at the target", () => {
    expect(curve(0.8999999)).toBeCloseTo(curve(0.9000001), 5);
    let prev = -Infinity;
    for (let u = 0; u <= 1; u += 0.01) {
      const c = curve(u);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe("apy", () => {
  const rT = 0.04 / SECONDS_PER_YEAR; // 4% at target

  it("borrow APY at target is ~4.08% (compounded)", () => {
    expect(borrowApy(0.9, rT)).toBeCloseTo(Math.exp(0.04) - 1, 10);
  });

  it("supply APY = borrowAPY * u * (1 - fee)", () => {
    const u = 0.9;
    expect(supplyApy(u, rT, 0.1)).toBeCloseTo(borrowApy(u, rT) * 0.9 * 0.9, 12);
  });

  it("utilisation handles empty markets and clamps to 1", () => {
    expect(utilization(0, 0)).toBe(0);
    expect(utilization(100, 150)).toBe(1);
    expect(utilization(200, 100)).toBe(0.5);
  });
});
