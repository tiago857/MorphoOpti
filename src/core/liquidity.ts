// Flagging markets whose free liquidity is gone or nearly gone.
//
// A fully borrowed market prints a huge supply APY: the Adaptive Curve IRM pushes the rate up hard
// above target utilization to pull in suppliers. That headline number is not yield you can rely on —
// it falls the moment fresh supply arrives, and while the market stays drained nothing supplied
// there can be withdrawn until borrowers repay or are liquidated. So the UI has to say so next to it.

export type LiquidityLevel = "ok" | "low" | "none";

/** Below this much free liquidity (in loan-token units, ≈ USD for stablecoins) a market is drained. */
export const NO_LIQUIDITY_ABS = 1;
/** Below this much free liquidity a market is thin enough that exits may not fill. */
export const LOW_LIQUIDITY_ABS = 10_000;
/** Free liquidity under this share of supply (i.e. utilization above 99.9%) counts as drained. */
export const NO_LIQUIDITY_SHARE = 0.001;
/** Free liquidity under this share of supply (utilization above 98%) counts as thin. */
export const LOW_LIQUIDITY_SHARE = 0.02;

/**
 * Classify a market's free liquidity. Both arguments must be in the same unit (USD or token amount);
 * `liquidity` is supply minus borrow, `supply` is total supplied.
 */
export function liquidityLevel(liquidity: number, supply: number): LiquidityLevel {
  if (!Number.isFinite(liquidity) || liquidity < NO_LIQUIDITY_ABS) return "none";
  const share = supply > 0 ? liquidity / supply : 1;
  if (share < NO_LIQUIDITY_SHARE) return "none";
  if (liquidity < LOW_LIQUIDITY_ABS || share < LOW_LIQUIDITY_SHARE) return "low";
  return "ok";
}

function amount(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });
}

/**
 * The specific liquidity problem with a market, in numbers, or undefined when there is none. Both
 * amounts are in loan-token units (≈ USD for the stablecoins this app manages).
 */
export function describeLiquidity(liquidity: number, supply: number, symbol: string): string | undefined {
  const level = liquidityLevel(liquidity, supply);
  if (level === "ok") return undefined;
  const free = Math.max(0, liquidity);
  const util = supply > 0 ? Math.min(100, ((supply - free) / supply) * 100) : 100;
  const utilText = util >= 99.95 && free > 0 ? ">99.9" : util.toFixed(1).replace(/\.0$/, "");
  if (level === "none") {
    return (
      `${amount(free)} ${symbol} liquidity available: ${utilText}% of the ${amount(supply)} ${symbol} supplied is borrowed. ` +
      `The APY is a utilization spike that drops as soon as new supply arrives, and anything supplied here ` +
      `cannot be withdrawn until borrowers repay.`
    );
  }
  return (
    `Only ${amount(free)} ${symbol} liquidity available (${utilText}% utilized). ` +
    `The APY is inflated and withdrawals may only partially fill.`
  );
}

/**
 * Combine a market's live liquidity note with the optimizer's issues for it. When an issue already
 * quotes the available liquidity (a stuck position, a blocked inflow), the generic note would only
 * repeat the same figure, so the more specific issue stands alone.
 */
export function mergeLiquidityIssue(liquidityText: string | undefined, issues: string[]): string[] {
  if (!liquidityText || issues.some((i) => i.includes("liquidity available"))) return issues;
  return [liquidityText, ...issues];
}
