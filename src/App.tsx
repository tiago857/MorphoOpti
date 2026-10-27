import { useCallback, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount } from "wagmi";
import { PoolSection } from "./components/PoolSection";
import { WalletButton } from "./components/WalletButton";
import { WhitelistPanel } from "./components/WhitelistPanel";
import { CHAINS, SUPPORTED_CHAIN_IDS, type SupportedChainId } from "./config/chains";
import { DEFAULT_FILTERS, type MarketFilters } from "./core/filters";
import type { PoolSettings } from "./core/pools";
import { DEFAULT_SORT, type MarketSort } from "./core/sort";
import {
  useAllMarkets,
  useAllVaults,
  usePoolAllocations,
  useWalletTokens,
  usePortfolios,
  useUserPositions,
  useVaultPositions,
} from "./hooks/useMarketData";
import type { PortfolioVault } from "./data/vaultOnchain";
import type { WalletToken } from "./data/wallet";
import { REFRESH_MS, useAutoRefresh } from "./hooks/useAutoRefresh";
import { useIdleCapital } from "./hooks/useIdleCapital";
import { parseUnits6, settingKey, useMarketSettings } from "./hooks/useMarketSettings";
import { useWhitelist } from "./hooks/useWhitelist";

const DEFAULT_WHITELIST_SIZE = 10;

function usePreviewAddress(): Address | undefined {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search).get("address")?.trim();
    return p && /^0x[0-9a-fA-F]{40}$/.test(p) ? (p as Address) : undefined;
  }, []);
}

export default function App() {
  const { address: connectedAddress } = useAccount();
  // Read-only preview: ?address=0x… renders the allocation for any address without connecting.
  // The connected wallet always wins, and rebalancing stays disabled while previewing.
  const previewAddress = usePreviewAddress();
  const address = connectedAddress ?? previewAddress;

  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<MarketSort>(DEFAULT_SORT);
  const markets = useAllMarkets();
  const vaults = useAllVaults();
  const settings = useMarketSettings();
  const autoRefresh = useAutoRefresh();

  // SUPPORTED_CHAIN_IDS is a fixed module constant, so these loops call the same hooks in the same
  // order on every render. Adding a chain is a code change, never a runtime one.
  const whitelistList = SUPPORTED_CHAIN_IDS.map((id) =>
    useWhitelist(
      id,
      useMemo(() => topMarketIds(markets.byChain[id], DEFAULT_WHITELIST_SIZE), [markets.byChain]),
    ),
  );
  const positionQueries = SUPPORTED_CHAIN_IDS.map((id) => useUserPositions(id, address));
  const vaultQueries = SUPPORTED_CHAIN_IDS.map((id, i) =>
    useVaultPositions(id, address, vaults.byChain[id], whitelistList[i].ids),
  );

  const whitelists = useMemo(() => {
    const out = {} as Record<SupportedChainId, (typeof whitelistList)[number]>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = whitelistList[i];
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, whitelistList);

  const whitelistByChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, Hex[]>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = whitelistList[i].ids;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, whitelistList.map((w) => w.ids));

  const positionsByChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, Hex[] | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = positionIds(positionQueries[i]);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, positionQueries.map((q) => q.data ?? q.isError));

  const walletQueries = SUPPORTED_CHAIN_IDS.map((id) => useWalletTokens(id, address));
  const walletByChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, Record<string, WalletToken> | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = walletQueries[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, walletQueries.map((q) => q.data));
  const idleCapital = useIdleCapital();

  const vaultsByChain = useMemo(() => {
    const out = {} as Record<SupportedChainId, PortfolioVault[] | undefined>;
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      out[id] = vaultQueries[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, vaultQueries.map((q) => q.data));

  const portfolios = usePortfolios({
    address,
    whitelistByChain,
    marketsByChain: markets.byChain,
    positionsByChain,
  });

  // Translate the stored settings (percentages and decimal strings) into optimizer units once.
  const poolSettings = useMemo<PoolSettings>(() => {
    const perMarket: PoolSettings["perMarket"] = {};
    for (const [key, s] of Object.entries(settings.settings.markets)) {
      const marketId = key.slice(key.indexOf(":") + 1);
      const locked = s.lockedUnits ? parseUnits6(s.lockedUnits) : undefined;
      perMarket[marketId] = {
        capFraction: s.capPct !== undefined && s.capPct > 0 ? s.capPct / 100 : undefined,
        locked: locked && locked > 0n ? locked : undefined,
      };
    }
    return {
      defaultCapFraction: settings.settings.defaultCapPct / 100,
      perMarket,
      // The Min liquidity filter also gates new capital: a market hidden for lacking liquidity must
      // not quietly receive funds just because it is still whitelisted. Stablecoins, so USD ≈ units.
      minLiquidity: BigInt(Math.round(filters.minLiquidityUsd * 1e6)),
    };
  }, [settings.settings, filters.minLiquidityUsd]);

  const pools = usePoolAllocations(
    portfolios.byChain,
    vaultsByChain,
    poolSettings,
    address,
    walletByChain,
    idleCapital.isEnabled,
  );

  // Per-market problems the optimizer found, so the Markets list can flag them next to the name.
  const issuesByMarket = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { pool, allocation } of pools) {
      for (const a of allocation.markets) {
        if (a.issues.length > 0) out[`${pool.chainId}:${a.id.toLowerCase()}`] = a.issues;
      }
    }
    return out;
  }, [pools]);

  // Pools are grouped under their chain, since a rebalance is per chain as well as per asset.
  // Chains holding the most capital lead.
  const poolsByChain = useMemo(() => {
    const groups = new Map<SupportedChainId, typeof pools>();
    // A pool with no capital in it is not an allocation, just a whitelist that has not been funded.
    // Idle wallet capital counts too, so a pool can be funded from the wallet before it holds anything.
    for (const entry of pools.filter((e) => e.pool.total > 0n || (e.pool.wallet?.balance ?? 0n) >= 1_000_000n)) {
      const id = entry.pool.chainId as SupportedChainId;
      const list = groups.get(id);
      if (list) list.push(entry);
      else groups.set(id, [entry]);
    }
    return Array.from(groups, ([chainId, entries]) => ({
      chainId,
      entries,
      total: entries.reduce((acc, e) => acc + e.pool.total, 0n),
    })).sort((a, b) => (a.total === b.total ? 0 : a.total > b.total ? -1 : 1));
  }, [pools]);

  const onSettled = useCallback(() => {
    for (const q of positionQueries) void q.refetch();
    for (const q of vaultQueries) void q.refetch();
    for (const q of walletQueries) void q.refetch();
    portfolios.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolios, ...positionQueries, ...vaultQueries, ...walletQueries]);

  // A manual refresh also reloads the API market and vault lists, which is where the yields come
  // from. onSettled leaves those alone: a rebalance moves positions, not rates.
  const refreshAll = useCallback(() => {
    markets.refetch();
    vaults.refetch();
    onSettled();
  }, [markets.refetch, vaults.refetch, onSettled]);

  const funded = poolsByChain.reduce((acc, g) => acc + g.entries.length, 0);
  const rpcHintChains = SUPPORTED_CHAIN_IDS.filter((id) => !CHAINS[id].rpcUrl);
  const loading = portfolios.isFetching || positionQueries.some((q) => q.isFetching);
  const refreshing = loading || markets.isFetching || vaults.isFetching;
  const dataError = portfolios.error ?? positionQueries.find((q) => q.error)?.error ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>MorphoOpti</h1>
          <span className="muted">Allocator for USDC, USDT and aUSD on Morpho Blue</span>
        </div>
        <div className="refresh-controls">
          <button
            className={autoRefresh.enabled ? "ghost toggle on" : "ghost toggle"}
            onClick={() => autoRefresh.setEnabled(!autoRefresh.enabled)}
            aria-pressed={autoRefresh.enabled}
            title={`Reload yields and positions every ${REFRESH_MS / 1000}s`}
          >
            <span className="dot" aria-hidden="true" />
            Auto-refresh {autoRefresh.enabled ? `${REFRESH_MS / 1000}s` : "off"}
          </button>
          <button className="ghost" onClick={refreshAll} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
        <WalletButton />
      </header>

      {!connectedAddress && previewAddress && (
        <p className="warn-box tiny">
          Read-only preview of <span className="mono">{previewAddress}</span>. Connect that wallet to rebalance.
        </p>
      )}

      {rpcHintChains.length > 0 && (
        <p className="warn-box tiny">
          Using public RPCs for {rpcHintChains.map((id) => CHAINS[id].name).join(", ")}. Set{" "}
          {rpcHintChains.map((id) => CHAINS[id].rpcEnvKey).join(", ")} in <code>.env</code> for reliability.
        </p>
      )}

      <main className="grid">
        <div className="col left">
          <WhitelistPanel
            rows={markets.rows}
            vaultRows={vaults.rows}
            loading={markets.isLoading || vaults.isLoading}
            error={markets.error}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            whitelists={whitelists}
            settings={settings}
            issues={issuesByMarket}
          />
        </div>
        <div className="col right">
          <section className="panel">
            <header className="panel-head">
              <h2>Allocation</h2>
              <span className="muted">
                {funded > 0 ? `${funded} funded ${funded === 1 ? "pool" : "pools"}` : ""}
                {loading ? " · refreshing…" : ""}
              </span>
              <button className="ghost" onClick={refreshAll} disabled={refreshing}>
                Refresh
              </button>
            </header>
            {dataError && <p className="error">{dataError.message}</p>}
            {!address && <p className="muted">Connect a wallet to load positions.</p>}
            {address && funded === 0 && !loading && (
              <p className="muted">
                No capital found in Morpho on any supported chain. A (chain, loan asset) pool appears here once it
                actually holds something.
              </p>
            )}
            <p className="tiny muted">
              Each loan asset rebalances on its own: a bundle can only move value between markets that share a loan
              token, so USDC, USDT and aUSD never mix, and neither do chains.
            </p>
          </section>

          {poolsByChain.map(({ chainId, entries, total }) => (
            <div key={chainId} className="chain-group">
              <h3 className="chain-heading">
                {CHAINS[chainId].name}
                <span className="muted tiny">
                  {entries.length} {entries.length === 1 ? "pool" : "pools"}
                  {total > 0n ? ` · ${entries.map((e) => e.pool.symbol).join(", ")}` : ""}
                </span>
              </h3>
              {entries.map(({ pool, allocation }) => (
                <PoolSection
                  key={`${pool.chainId}:${pool.loanToken}`}
                  pool={pool}
                  allocation={allocation}
                  onSettled={onSettled}
                  previewOnly={!connectedAddress}
                  idleEnabled={idleCapital.isEnabled(pool.chainId, pool.loanToken)}
                  onToggleIdle={() => idleCapital.toggle(pool.chainId, pool.loanToken)}
                />
              ))}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

function topMarketIds(markets: { marketId: string }[] | undefined, n: number): Hex[] | undefined {
  return markets?.slice(0, n).map((m) => m.marketId as Hex);
}

function positionIds(q: ReturnType<typeof useUserPositions>): Hex[] | undefined {
  if (q.data) return q.data.map((p) => p.marketId);
  if (q.isError) return [];
  return undefined;
}

// Re-exported for the settings key format used when reading overrides back out.
export { settingKey };
