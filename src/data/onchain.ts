import type { Address, Hex, PublicClient } from "viem";
import { irmAbi } from "../abi/irm";
import { morphoAbi } from "../abi/morpho";
import type { ChainConfig } from "../config/chains";
import { accrueMarket } from "../core/accrue";
import { toAssetsDown, wadToNumber } from "../core/math";
import type { MarketMeta, MarketParams, MarketState, Portfolio, PortfolioMarket } from "../core/types";
import { rewardApr, type ApiMarket } from "./morphoApi";

export interface FetchPortfolioArgs {
  client: PublicClient;
  chain: ChainConfig;
  user: Address;
  /** Every market to load: whitelist ∪ markets where the user has a position. */
  marketIds: Hex[];
  whitelist: Set<string>;
  apiMarkets: Map<string, ApiMarket>;
}

/**
 * Reads authoritative market + position state from Morpho Blue and the IRM in two multicalls,
 * accrues interest to the latest block, and merges API metadata (symbols, rewards, USD size).
 */
export async function fetchPortfolio(args: FetchPortfolioArgs): Promise<Portfolio> {
  const { client, chain, user, marketIds, whitelist, apiMarkets } = args;
  const ids = Array.from(new Set(marketIds.map((id) => id.toLowerCase() as Hex)));

  const [block, authorized] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    client.readContract({
      address: chain.morpho,
      abi: morphoAbi,
      functionName: "isAuthorized",
      args: [user, chain.generalAdapter1],
    }),
  ]);

  if (ids.length === 0) {
    return { chainId: chain.id, user, markets: [], total: 0n, isAuthorized: authorized, fetchedAt: Date.now() };
  }

  // Round 1: market state, position, params.
  const round1 = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address: chain.morpho, abi: morphoAbi, functionName: "market", args: [id] } as const,
      { address: chain.morpho, abi: morphoAbi, functionName: "position", args: [id, user] } as const,
      { address: chain.morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [id] } as const,
    ]),
  });

  const raw = ids.map((id, i) => {
    const m = round1[i * 3] as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    const p = round1[i * 3 + 1] as readonly [bigint, bigint, bigint];
    const mp = round1[i * 3 + 2] as readonly [Address, Address, Address, Address, bigint];
    const state: MarketState = {
      totalSupplyAssets: m[0],
      totalSupplyShares: m[1],
      totalBorrowAssets: m[2],
      totalBorrowShares: m[3],
      lastUpdate: m[4],
      fee: m[5],
    };
    const params: MarketParams = { loanToken: mp[0], collateralToken: mp[1], oracle: mp[2], irm: mp[3], lltv: mp[4] };
    return { id, state, params, supplyShares: p[0] };
  });

  // Round 2: IRM rates, only for markets on the Adaptive Curve IRM.
  // allowFailure is false on purpose: a transient RPC failure must surface as an error rather than
  // silently become a 0% rate, which would make the optimizer drain a perfectly good market.
  const irmIdx = raw.map((r, i) => (r.params.irm.toLowerCase() === chain.adaptiveCurveIrm.toLowerCase() ? i : -1)).filter((i) => i >= 0);
  const rates = new Map<number, { rateAtTarget: bigint; borrowRate: bigint }>();
  if (irmIdx.length > 0) {
    const round2 = await client.multicall({
      allowFailure: false,
      contracts: irmIdx.flatMap((i) => [
        { address: chain.adaptiveCurveIrm, abi: irmAbi, functionName: "rateAtTarget", args: [raw[i].id] } as const,
        {
          address: chain.adaptiveCurveIrm,
          abi: irmAbi,
          functionName: "borrowRateView",
          args: [raw[i].params, raw[i].state],
        } as const,
      ]),
    });
    irmIdx.forEach((i, k) => {
      rates.set(i, {
        rateAtTarget: round2[k * 2] as bigint,
        borrowRate: round2[k * 2 + 1] as bigint,
      });
    });
  }

  const now = block.timestamp;
  const markets: PortfolioMarket[] = raw.map((r, i) => {
    const known = rates.get(i);
    const rate = known ?? { rateAtTarget: 0n, borrowRate: 0n };
    const state = accrueMarket(r.state, rate.borrowRate, now);
    const supplyAssets = toAssetsDown(r.supplyShares, state.totalSupplyAssets, state.totalSupplyShares);
    const api = apiMarkets.get(r.id);
    return {
      id: r.id,
      params: r.params,
      state,
      rateAtTargetWad: rate.rateAtTarget < 0n ? 0n : rate.rateAtTarget,
      borrowRateWad: rate.borrowRate,
      rateKnown: known !== undefined,
      supplyShares: r.supplyShares,
      supplyAssets,
      whitelisted: whitelist.has(r.id),
      meta: buildMeta(r.params, state, api),
    };
  });

  const total = markets.reduce((acc, m) => acc + m.supplyAssets, 0n);
  return { chainId: chain.id, user, markets, total, isAuthorized: authorized, fetchedAt: Date.now() };
}

function buildMeta(params: MarketParams, state: MarketState, api: ApiMarket | undefined): MarketMeta {
  const rewards = (api?.state?.rewards ?? [])
    .filter((r) => r.asset && (r.supplyApr ?? 0) > 0)
    .map((r) => ({ symbol: r.asset!.symbol, address: r.asset!.address, supplyApr: r.supplyApr ?? 0 }));
  return {
    collateralSymbol: api?.collateralAsset?.symbol ?? `${params.collateralToken.slice(0, 6)}…${params.collateralToken.slice(-4)}`,
    collateralAddress: params.collateralToken,
    lltv: wadToNumber(params.lltv),
    supplyAssetsUsd: api?.state?.supplyAssetsUsd ?? Number(state.totalSupplyAssets) / 1e6,
    liquidityAssets: state.totalSupplyAssets - state.totalBorrowAssets,
    apiSupplyApy: api?.state?.supplyApy ?? 0,
    rewards,
    rewardApr: api ? rewardApr(api) : 0,
  };
}
