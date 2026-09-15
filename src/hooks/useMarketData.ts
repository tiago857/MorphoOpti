import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address, Hex, PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { CHAINS, type SupportedChainId } from "../config/chains";
import { optimizeAllocation, type AllocationResult } from "../core/optimizer";
import type { Portfolio } from "../core/types";
import { fetchMarketsByIds, fetchUsdcMarkets, fetchUserPositions, type ApiMarket } from "../data/morphoApi";
import { fetchPortfolio } from "../data/onchain";

export const REFRESH_MS = 60_000;

/** Listed USDC markets on a chain from the Morpho API. */
export function useUsdcMarkets(chainId: SupportedChainId) {
  const chain = CHAINS[chainId];
  return useQuery({
    queryKey: ["usdc-markets", chainId],
    queryFn: () => fetchUsdcMarkets(chainId, chain.usdc),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}

/** User's USDC supply positions on a chain, as indexed by the Morpho API. */
export function useUserPositions(chainId: SupportedChainId, address: Address | undefined) {
  const chain = CHAINS[chainId];
  return useQuery({
    queryKey: ["positions", chainId, address],
    enabled: !!address,
    queryFn: async () => {
      const all = await fetchUserPositions(chainId, address!);
      return all.filter((p) => p.loanAsset.toLowerCase() === chain.usdc.toLowerCase());
    },
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}

export interface UsePortfolioArgs {
  chainId: SupportedChainId;
  address: Address | undefined;
  whitelistIds: Hex[];
  apiMarkets: ApiMarket[] | undefined;
  positionMarketIds: Hex[] | undefined;
}

/** Authoritative on-chain portfolio for whitelist ∪ held markets, accrued to the latest block. */
export function usePortfolio({ chainId, address, whitelistIds, apiMarkets, positionMarketIds }: UsePortfolioArgs) {
  const chain = CHAINS[chainId];
  const client = usePublicClient({ chainId });

  const marketIds = useMemo(() => {
    const set = new Set<string>();
    for (const id of whitelistIds) set.add(id.toLowerCase());
    for (const id of positionMarketIds ?? []) set.add(id.toLowerCase());
    return Array.from(set).sort() as Hex[];
  }, [whitelistIds, positionMarketIds]);

  const apiMap = useMemo(() => {
    const map = new Map<string, ApiMarket>();
    for (const m of apiMarkets ?? []) map.set(m.marketId.toLowerCase(), m);
    return map;
  }, [apiMarkets]);

  return useQuery({
    queryKey: ["portfolio", chainId, address, marketIds, apiMarkets ? apiMarkets.length : -1],
    enabled: !!address && !!client && positionMarketIds !== undefined,
    queryFn: async (): Promise<Portfolio> => {
      // Fill in API metadata for any market not in the listed set (held but unlisted, or pasted by id).
      const missing = marketIds.filter((id) => !apiMap.has(id));
      const merged = new Map(apiMap);
      if (missing.length > 0) {
        try {
          for (const m of await fetchMarketsByIds(chainId, missing)) merged.set(m.marketId.toLowerCase(), m);
        } catch {
          // metadata is cosmetic; on-chain data is authoritative
        }
      }
      return fetchPortfolio({
        // usePublicClient returns a per-chain union (Base carries OP-stack block types); we only use
        // getBlock/readContract/multicall, which are identical across both.
        client: client as unknown as PublicClient,
        chain,
        user: address!,
        marketIds,
        whitelist: new Set(whitelistIds.map((w) => w.toLowerCase())),
        apiMarkets: merged,
      });
    },
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    placeholderData: (prev) => prev,
  });
}

export function useAllocation(portfolio: Portfolio | undefined, capFraction: number): AllocationResult | undefined {
  return useMemo(() => {
    if (!portfolio) return undefined;
    return optimizeAllocation(
      portfolio.markets.map((m) => ({
        id: m.id,
        totalSupplyAssets: m.state.totalSupplyAssets,
        totalBorrowAssets: m.state.totalBorrowAssets,
        feeWad: m.state.fee,
        rateAtTargetWad: m.rateAtTargetWad,
        rewardApr: m.meta.rewardApr,
        position: m.supplyAssets,
        whitelisted: m.whitelisted,
        pinned: !m.rateKnown,
      })),
      { capFraction },
    );
  }, [portfolio, capFraction]);
}
