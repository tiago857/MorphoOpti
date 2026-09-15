import type { Address, Hex } from "viem";

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint; // WAD
}

export interface RewardInfo {
  symbol: string;
  address: Address;
  supplyApr: number; // fraction
}

export interface MarketMeta {
  collateralSymbol: string;
  collateralAddress: Address | null;
  lltv: number; // fraction, e.g. 0.86
  supplyAssetsUsd: number;
  liquidityAssets: bigint;
  apiSupplyApy: number; // fraction, as reported by Morpho API
  rewards: RewardInfo[];
  rewardApr: number; // sum of reward supply APRs, fraction
}

/** Everything the UI and optimizer need about one market for the connected user. */
export interface PortfolioMarket {
  id: Hex;
  params: MarketParams;
  /** Market state accrued to "now". */
  state: MarketState;
  /** Per-second rate at target utilization, WAD. */
  rateAtTargetWad: bigint;
  /** Current per-second borrow rate from the IRM, WAD. */
  borrowRateWad: bigint;
  /**
   * False when the market does not use the Adaptive Curve IRM, so its yield cannot be modelled.
   * Such markets are pinned at their current allocation rather than assumed to earn 0%.
   */
  rateKnown: boolean;
  supplyShares: bigint;
  /** User's supplied USDC (accrued), in token units (6 decimals). */
  supplyAssets: bigint;
  whitelisted: boolean;
  meta: MarketMeta;
}

export interface Portfolio {
  chainId: number;
  user: Address;
  markets: PortfolioMarket[];
  total: bigint;
  isAuthorized: boolean;
  fetchedAt: number;
}
