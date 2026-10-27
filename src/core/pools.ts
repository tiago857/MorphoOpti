// A pool is one (chain, loan asset) pair. It is the unit the optimizer and the rebalance bundle both
// work on: Bundler3 moves value by withdrawing into an adapter and supplying back out, which can only
// ever happen within a single loan asset. Splitting the portfolio here keeps that invariant explicit.

import type { Address } from "viem";
import type { PortfolioVault } from "../data/vaultOnchain";
import { describeLiquidity, liquidityLevel } from "./liquidity";
import { optimizeAllocation, type AllocationResult, type OptimizerMarketInput } from "./optimizer";
import type { Portfolio, PortfolioMarket } from "./types";

export interface PoolPortfolio {
  chainId: number;
  loanToken: Address;
  symbol: string;
  user: Address;
  markets: PortfolioMarket[];
  /** ERC-4626 vaults denominated in this pool's loan asset. */
  vaults: PortfolioVault[];
  /** Total supplied by the user across this pool's markets and vaults. */
  total: bigint;
  /** The user's idle loan-token balance and its allowance to GeneralAdapter1, when known. */
  wallet?: { balance: bigint; allowance: bigint };
  /** Wallet capital the user chose to deploy into this pool (0 or the whole idle balance). */
  idle?: bigint;
  isAuthorized: boolean;
  fetchedAt: number;
}

/** Per-market overrides, keyed by lowercased market id. */
export interface PoolSettings {
  defaultCapFraction: number;
  perMarket: Record<string, { capFraction?: number; locked?: bigint }>;
  /**
   * Free liquidity (token units) a market needs before it may receive new capital — the market
   * list's Min liquidity filter. Markets with effectively none are always excluded.
   */
  minLiquidity?: bigint;
}

/**
 * Split a chain's portfolio into one pool per loan asset. Pools are ordered by the user's holdings
 * first (so a pool with money in it leads), then by market count.
 */
export function splitByLoanAsset(portfolio: Portfolio, vaults: PortfolioVault[] = []): PoolPortfolio[] {
  const byToken = new Map<string, { markets: PortfolioMarket[]; vaults: PortfolioVault[] }>();
  const bucket = (key: string) => {
    let b = byToken.get(key);
    if (!b) byToken.set(key, (b = { markets: [], vaults: [] }));
    return b;
  };
  for (const m of portfolio.markets) bucket(m.params.loanToken.toLowerCase()).markets.push(m);
  // A vault joins the pool of its underlying asset: that is the only pool it can exchange value with.
  for (const v of vaults) bucket(v.asset.toLowerCase()).vaults.push(v);

  const pools: PoolPortfolio[] = [];
  for (const { markets, vaults: vs } of byToken.values()) {
    const loanToken = markets[0]?.params.loanToken ?? vs[0].asset;
    pools.push({
      chainId: portfolio.chainId,
      loanToken,
      symbol: markets[0]?.meta.loanSymbol ?? vs[0].assetSymbol,
      user: portfolio.user,
      markets,
      vaults: vs,
      total:
        markets.reduce((acc, m) => acc + m.supplyAssets, 0n) + vs.reduce((acc, v) => acc + v.supplyAssets, 0n),
      isAuthorized: portfolio.isAuthorized,
      fetchedAt: portfolio.fetchedAt,
    });
  }

  return pools.sort((a, b) => {
    if (a.total !== b.total) return a.total > b.total ? -1 : 1;
    const an = a.markets.length + a.vaults.length;
    const bn = b.markets.length + b.vaults.length;
    if (an !== bn) return bn - an;
    return a.symbol.localeCompare(b.symbol);
  });
}

export function toOptimizerInputs(pool: PoolPortfolio, settings: PoolSettings): OptimizerMarketInput[] {
  const vaultInputs: OptimizerMarketInput[] = pool.vaults.map((v) => {
    const override = settings.perMarket[v.id.toLowerCase()];
    return {
      id: v.id,
      // A vault has no IRM curve; its rate is taken flat, net of the vault fee.
      flatApy: v.apyAfterFee,
      totalSupplyAssets: v.totalAssets,
      // The optimizer derives available liquidity as supply minus borrow. A vault has no borrows,
      // but it does have a withdrawal limit, so express that limit in the same terms: whatever the
      // vault cannot pay out right now behaves exactly like borrowed-out capital.
      totalBorrowAssets: v.totalAssets > v.maxWithdraw ? v.totalAssets - v.maxWithdraw : 0n,
      feeWad: 0n,
      rateAtTargetWad: 0n,
      rewardApr: v.rewardApr,
      position: v.supplyAssets,
      whitelisted: v.whitelisted,
      capFraction: override?.capFraction,
      locked: override?.locked,
    };
  });

  const marketInputs = pool.markets.map((m) => {
    const override = settings.perMarket[m.id.toLowerCase()];
    const { totalSupplyAssets: s, totalBorrowAssets: b } = m.state;
    const free = s > b ? s - b : 0n;
    const noInflowReason = inflowBlockReason(free, s, settings.minLiquidity ?? 0n, m.meta.loanSymbol);
    return {
      id: m.id,
      noInflow: noInflowReason !== undefined,
      noInflowReason,
      totalSupplyAssets: m.state.totalSupplyAssets,
      totalBorrowAssets: m.state.totalBorrowAssets,
      feeWad: m.state.fee,
      rateAtTargetWad: m.rateAtTargetWad,
      rewardApr: m.meta.rewardApr,
      position: m.supplyAssets,
      whitelisted: m.whitelisted,
      capFraction: override?.capFraction,
      locked: override?.locked,
      pinned: !m.rateKnown,
    };
  });

  return [...marketInputs, ...vaultInputs];
}

export function optimizePool(pool: PoolPortfolio, settings: PoolSettings): AllocationResult {
  return optimizeAllocation(toOptimizerInputs(pool, settings), {
    capFraction: settings.defaultCapFraction,
    symbol: pool.symbol,
    idle: pool.idle ?? 0n,
  });
}

/**
 * Why a market may not receive new capital, or undefined when it may. Either it is effectively
 * drained, or its free liquidity is under the Min liquidity filter the user set on the market list.
 * Every managed loan asset is 6-decimal, so units divide by 1e6 to get token amounts.
 */
function inflowBlockReason(free: bigint, supply: bigint, minLiquidity: bigint, symbol: string): string | undefined {
  const freeTokens = Number(free) / 1e6;
  const supplyTokens = Number(supply) / 1e6;
  // Drained outright, or by utilization even with a few dollars left: the specific numbers say which.
  if (liquidityLevel(freeTokens, supplyTokens) === "none") return describeLiquidity(freeTokens, supplyTokens, symbol);
  if (free < minLiquidity) {
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return `Only ${fmt(freeTokens)} ${symbol} liquidity available, below your ${fmt(Number(minLiquidity) / 1e6)} Min liquidity filter.`;
  }
  return undefined;
}
