// Morpho vaults (ERC-4626) as an allocation venue alongside raw markets.
//
// A vault differs from a market in three ways that matter here:
//   1. Its yield has no IRM curve to model — the vault reallocates internally, so its rate is taken
//      as flat rather than simulated against your own deposit size.
//   2. It charges a performance fee, which the depositor never sees in the quoted gross APY.
//   3. Exiting one needs the adapter to hold your vault *shares*, which is an ERC-20 approval.

import type { Address } from "viem";

export interface VaultInfo {
  address: Address;
  name: string;
  /** The vault's underlying asset; this is what makes it part of a (chain, loan asset) pool. */
  asset: Address;
  assetSymbol: string;
  /** Gross APY of the underlying allocation, before the vault's fee. */
  baseApy: number;
  /** Performance fee as a fraction, e.g. 0.05 for 5%. */
  fee: number;
  /** Sum of reward/incentive APRs paid on top. */
  rewardApr: number;
  /** Total assets under management, in token units. */
  totalAssets: bigint;
  totalAssetsUsd: number;
}

/**
 * What a depositor actually earns: gross yield less the vault's cut, plus incentives.
 *
 * The fee applies to the yield the vault generates, not to incentives, which are paid by a third
 * party directly to depositors.
 */
export function vaultNetApy(v: Pick<VaultInfo, "baseApy" | "fee" | "rewardApr">): number {
  return v.baseApy * (1 - v.fee) + v.rewardApr;
}

/** Yield after the fee but before incentives — the part that behaves like a market's supply APY. */
export function vaultApyAfterFee(v: Pick<VaultInfo, "baseApy" | "fee">): number {
  return v.baseApy * (1 - v.fee);
}

/**
 * ERC-4626 share price scaled by 1e27, matching the `sharePriceE27` bounds GeneralAdapter1 takes.
 * Uses the same +1 / +offset convention as the market share math so an empty vault does not divide
 * by zero.
 */
export function vaultSharePriceE27(totalAssets: bigint, totalShares: bigint): bigint {
  return ((totalAssets + 1n) * 10n ** 27n) / (totalShares + 1n);
}

/** Assets a share balance is worth, rounding down as the vault does. */
export function vaultConvertToAssets(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (totalShares === 0n) return 0n;
  return (shares * (totalAssets + 1n)) / (totalShares + 1n);
}

/** Shares needed to withdraw `assets`, rounding up so the withdrawal is always covered. */
export function vaultConvertToShares(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (totalAssets === 0n) return 0n;
  const num = assets * (totalShares + 1n);
  const den = totalAssets + 1n;
  return num % den === 0n ? num / den : num / den + 1n;
}

/** True when the adapter can already pull enough shares to exit this position. */
export function hasVaultApproval(shares: bigint, allowance: bigint): boolean {
  return shares === 0n || allowance >= shares;
}
