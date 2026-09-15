import { toSharesDown, wMulDown, wTaylorCompounded } from "./math";
import type { MarketState } from "./types";

/**
 * Replicates Morpho Blue's `_accrueInterest` off-chain so that share -> asset conversions
 * reflect interest earned since the market's last on-chain update.
 */
export function accrueMarket(state: MarketState, borrowRateWad: bigint, nowSeconds: bigint): MarketState {
  const elapsed = nowSeconds - state.lastUpdate;
  if (elapsed <= 0n || state.totalBorrowAssets === 0n || borrowRateWad === 0n) {
    return { ...state, lastUpdate: elapsed > 0n ? nowSeconds : state.lastUpdate };
  }

  const interest = wMulDown(state.totalBorrowAssets, wTaylorCompounded(borrowRateWad, elapsed));
  let totalSupplyAssets = state.totalSupplyAssets + interest;
  let totalSupplyShares = state.totalSupplyShares;
  const totalBorrowAssets = state.totalBorrowAssets + interest;

  if (state.fee > 0n) {
    const feeAmount = wMulDown(interest, state.fee);
    // Fee shares are minted against the supply *excluding* the fee amount, as on-chain.
    const feeShares = toSharesDown(feeAmount, totalSupplyAssets - feeAmount, totalSupplyShares);
    totalSupplyShares += feeShares;
  }

  return {
    totalSupplyAssets,
    totalSupplyShares,
    totalBorrowAssets,
    totalBorrowShares: state.totalBorrowShares,
    lastUpdate: nowSeconds,
    fee: state.fee,
  };
}
