import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address, Hex, PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { CHAINS, SUPPORTED_CHAIN_IDS, type SupportedChainId } from "../config/chains";
import { optimizePool, splitByLoanAsset, type PoolPortfolio, type PoolSettings } from "../core/pools";
import { isMarketId } from "../core/venue";
import type { AllocationResult } from "../core/optimizer";
import type { Portfolio } from "../core/types";
import {
  fetchMarketsByIds,
  fetchMarketsForAssets,
  fetchUserPositions,
  fetchVaultsForAssets,
  type ApiMarket,
  type ApiVault,
} from "../data/morphoApi";
import { fetchPortfolio } from "../data/onchain";
import { fetchVaultPositions, type PortfolioVault } from "../data/vaultOnchain";
import { fetchWalletTokens, type WalletToken } from "../data/wallet";
import { REFRESH_MS, useRefreshInterval } from "./useAutoRefresh";

/** An API market tagged with the chain it came from, since the list spans every supported chain. */
export interface ChainMarket {
  chainId: SupportedChainId;
  market: ApiMarket;
}

/** Listed markets on a chain for every loan asset that chain supports. */
export function useChainMarkets(chainId: SupportedChainId) {
  const chain = CHAINS[chainId];
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["markets", chainId],
    queryFn: () => fetchMarketsForAssets(chainId, chain.loanAssets.map((a) => a.address)),
    staleTime: REFRESH_MS,
    refetchInterval,
  });
}

/**
 * Every listed market across all supported chains, tagged with its chain. Chain is a filter in the UI
 * rather than a mode switch, so the list has to span chains.
 */
export function useAllMarkets() {
  // SUPPORTED_CHAIN_IDS is a module-level constant of fixed length, so this loop calls the same hooks
  // in the same order on every render. Adding a chain is a code change, never a runtime one.
  const queries = SUPPORTED_CHAIN_IDS.map((id) => useChainMarkets(id));

  const byChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, ApiMarket[] | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = queries[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, queries.map((q) => q.data));

  const rows = useMemo<ChainMarket[]>(() => {
    const out: ChainMarket[] = [];
    for (const id of SUPPORTED_CHAIN_IDS) {
      for (const market of byChain[id] ?? []) out.push({ chainId: id, market });
    }
    return out;
  }, [byChain]);

  const refetch = useMemo(
    () => () => {
      for (const q of queries) void q.refetch();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    queries,
  );

  return {
    rows,
    byChain,
    isLoading: queries.some((q) => q.isLoading),
    isFetching: queries.some((q) => q.isFetching),
    refetch,
    // A chain that fails should not blank the whole list, so surface one error without hiding the rest.
    error: queries.find((q) => q.error)?.error ?? null,
  };
}

/** An API vault tagged with its chain, so the market list can show vaults next to markets. */
export interface ChainVault {
  chainId: SupportedChainId;
  vault: ApiVault;
}

/** Listed vaults on a chain whose underlying asset is one this app manages. */
export function useChainVaults(chainId: SupportedChainId) {
  const chain = CHAINS[chainId];
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["vaults", chainId],
    queryFn: () => fetchVaultsForAssets(chainId, chain.loanAssets.map((a) => a.address)),
    staleTime: REFRESH_MS,
    refetchInterval,
  });
}

/** Every listed vault across all supported chains. */
export function useAllVaults() {
  const queries = SUPPORTED_CHAIN_IDS.map((id) => useChainVaults(id));

  const byChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, ApiVault[] | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = queries[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, queries.map((q) => q.data));

  const rows = useMemo<ChainVault[]>(() => {
    const out: ChainVault[] = [];
    for (const id of SUPPORTED_CHAIN_IDS) for (const vault of byChain[id] ?? []) out.push({ chainId: id, vault });
    return out;
  }, [byChain]);

  const refetch = useMemo(
    () => () => {
      for (const q of queries) void q.refetch();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    queries,
  );

  return {
    rows,
    byChain,
    isLoading: queries.some((q) => q.isLoading),
    isFetching: queries.some((q) => q.isFetching),
    refetch,
  };
}

/** Live share balances, vault size and adapter allowance for one chain's vaults. */
export function useVaultPositions(
  chainId: SupportedChainId,
  address: Address | undefined,
  apiVaults: ApiVault[] | undefined,
  whitelistIds: Hex[],
) {
  const chain = CHAINS[chainId];
  const client = usePublicClient({ chainId });
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["vault-positions", chainId, address, apiVaults?.length ?? -1, whitelistIds],
    enabled: !!address && !!client && !!apiVaults,
    queryFn: (): Promise<PortfolioVault[]> =>
      fetchVaultPositions({
        client: client as unknown as PublicClient,
        chain,
        user: address!,
        vaults: apiVaults!,
        whitelist: new Set(whitelistIds.map((w) => w.toLowerCase())),
      }),
    staleTime: REFRESH_MS,
    refetchInterval,
    placeholderData: (prev) => prev,
  });
}

/** Idle wallet balances of the chain's managed loan assets, and their allowance to the adapter. */
export function useWalletTokens(chainId: SupportedChainId, address: Address | undefined) {
  const chain = CHAINS[chainId];
  const client = usePublicClient({ chainId });
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["wallet-tokens", chainId, address],
    enabled: !!address && !!client,
    queryFn: () => fetchWalletTokens(client as unknown as PublicClient, chain, address!),
    staleTime: REFRESH_MS,
    refetchInterval,
    placeholderData: (prev) => prev,
  });
}

/** The user's supply positions on a chain, restricted to the loan assets this app manages. */
export function useUserPositions(chainId: SupportedChainId, address: Address | undefined) {
  const chain = CHAINS[chainId];
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["positions", chainId, address],
    enabled: !!address,
    queryFn: async () => {
      const managed = new Set(chain.loanAssets.map((a) => a.address.toLowerCase()));
      const all = await fetchUserPositions(chainId, address!);
      return all.filter((p) => managed.has(p.loanAsset.toLowerCase()));
    },
    staleTime: REFRESH_MS,
    refetchInterval,
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
    // The whitelist holds both market ids and vault addresses. Only market ids belong here — a
    // 20-byte vault address passed to Morpho.market(bytes32) aborts the whole multicall.
    for (const id of whitelistIds) if (isMarketId(id)) set.add(id.toLowerCase());
    for (const id of positionMarketIds ?? []) if (isMarketId(id)) set.add(id.toLowerCase());
    return Array.from(set).sort() as Hex[];
  }, [whitelistIds, positionMarketIds]);

  const apiMap = useMemo(() => {
    const map = new Map<string, ApiMarket>();
    for (const m of apiMarkets ?? []) map.set(m.marketId.toLowerCase(), m);
    return map;
  }, [apiMarkets]);

  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: ["portfolio", chainId, address, marketIds, apiMarkets ? apiMarkets.length : -1],
    enabled: !!address && !!client && positionMarketIds !== undefined && marketIds.length > 0,
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
    refetchInterval,
    placeholderData: (prev) => prev,
  });
}

export interface UsePoolsArgs {
  address: Address | undefined;
  /** Whitelisted market ids per chain. */
  whitelistByChain: Record<SupportedChainId, Hex[]>;
  marketsByChain: Record<SupportedChainId, ApiMarket[] | undefined>;
  positionsByChain: Record<SupportedChainId, Hex[] | undefined>;
}

/** One optimized allocation per (chain, loan asset) pool, across every supported chain. */
export interface PoolAllocation {
  pool: PoolPortfolio;
  allocation: AllocationResult;
}

/**
 * Portfolios for every supported chain. On-chain reads stay one batched multicall per chain; the
 * split into per-asset pools happens afterwards, in pure code.
 */
export function usePortfolios({ address, whitelistByChain, marketsByChain, positionsByChain }: UsePoolsArgs) {
  // Same fixed-length constant as useAllMarkets, so hook order is stable across renders.
  const queries = SUPPORTED_CHAIN_IDS.map((id) =>
    usePortfolio({
      chainId: id,
      address,
      whitelistIds: whitelistByChain[id] ?? [],
      apiMarkets: marketsByChain[id],
      positionMarketIds: positionsByChain[id],
    }),
  );

  const byChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, Portfolio | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = queries[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, queries.map((q) => q.data));

  const refetch = useMemo(
    () => () => {
      for (const q of queries) void q.refetch();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    queries,
  );

  const byChainQueries = {} as Record<SupportedChainId, UseQueryResult<Portfolio>>;
  SUPPORTED_CHAIN_IDS.forEach((id, i) => {
    byChainQueries[id] = queries[i];
  });

  return {
    byChain,
    isFetching: queries.some((q) => q.isFetching),
    error: queries.find((q) => q.error)?.error ?? null,
    refetch,
    queries: byChainQueries,
  };
}

/** Split every chain's portfolio into pools and optimize each one independently. */
export function usePoolAllocations(
  byChain: Record<SupportedChainId, Portfolio | undefined>,
  vaultsByChain: Record<SupportedChainId, PortfolioVault[] | undefined>,
  settings: PoolSettings,
  address: Address | undefined,
  walletByChain: Record<SupportedChainId, Record<string, WalletToken> | undefined>,
  /** Whether the user chose to deploy idle wallet capital into a given (chain, token) pool. */
  idleEnabled: (chainId: number, loanToken: string) => boolean,
): PoolAllocation[] {
  return useMemo(() => {
    const out: PoolAllocation[] = [];
    for (const id of SUPPORTED_CHAIN_IDS) {
      const vaults = vaultsByChain[id] ?? [];
      let portfolio = byChain[id];
      if (!portfolio) {
        // A chain can hold vaults and no markets at all, in which case the market portfolio query
        // never runs. Stand in an empty one so those vaults still form a pool instead of vanishing.
        if (vaults.length === 0 || !address) continue;
        portfolio = {
          chainId: id,
          user: address,
          markets: [],
          total: 0n,
          // No market legs means no Morpho authorization is involved; the panel decides per bundle.
          isAuthorized: false,
          fetchedAt: Date.now(),
        };
      }
      for (const split of splitByLoanAsset(portfolio, vaults)) {
        const wallet = walletByChain[id]?.[split.loanToken.toLowerCase()];
        const idle = wallet && idleEnabled(id, split.loanToken) ? wallet.balance : 0n;
        const pool: PoolPortfolio = { ...split, wallet, idle };
        out.push({ pool, allocation: optimizePool(pool, settings) });
      }
    }
    // Pools holding money lead; empty pools still render so their markets are visible.
    return out.sort((a, b) => (a.pool.total === b.pool.total ? 0 : a.pool.total > b.pool.total ? -1 : 1));
  }, [byChain, vaultsByChain, settings, address, walletByChain, idleEnabled]);
}
