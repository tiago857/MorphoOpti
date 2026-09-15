// Adaptive Curve IRM model (number-space, for the optimizer).
// Reference: morpho-org/morpho-blue-irm AdaptiveCurveIrm.sol
//   err   = (u - 0.9) / 0.1  if u > 0.9 else (u - 0.9) / 0.9
//   curve = 1 + 3*err       if err >= 0 else 1 + 0.75*err
//   borrowRate = rateAtTarget * curve

import { SECONDS_PER_YEAR } from "./math";

export const TARGET_UTILIZATION = 0.9;
export const CURVE_STEEPNESS = 4;

export function utilization(totalSupply: number, totalBorrow: number): number {
  if (totalSupply <= 0) return 0;
  return Math.min(totalBorrow / totalSupply, 1);
}

export function curve(u: number): number {
  const err =
    u > TARGET_UTILIZATION
      ? (u - TARGET_UTILIZATION) / (1 - TARGET_UTILIZATION)
      : (u - TARGET_UTILIZATION) / TARGET_UTILIZATION;
  return err >= 0 ? 1 + (CURVE_STEEPNESS - 1) * err : 1 + (1 - 1 / CURVE_STEEPNESS) * err;
}

/** Per-second borrow rate (as a plain fraction, not WAD). */
export function borrowRatePerSecond(u: number, rateAtTargetPerSecond: number): number {
  return rateAtTargetPerSecond * curve(u);
}

/** Convert a per-second rate to a compounded annual yield. */
export function rateToApy(ratePerSecond: number): number {
  return Math.exp(ratePerSecond * SECONDS_PER_YEAR) - 1;
}

export function borrowApy(u: number, rateAtTargetPerSecond: number): number {
  return rateToApy(borrowRatePerSecond(u, rateAtTargetPerSecond));
}

/** Morpho convention: supplyAPY = borrowAPY * utilization * (1 - fee). */
export function supplyApy(u: number, rateAtTargetPerSecond: number, fee: number): number {
  return borrowApy(u, rateAtTargetPerSecond) * u * (1 - fee);
}
