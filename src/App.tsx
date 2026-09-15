import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount } from "wagmi";
import { AllocationTable } from "./components/AllocationTable";
import { ChainSelector } from "./components/ChainSelector";
import { RebalancePanel } from "./components/RebalancePanel";
import { WalletButton } from "./components/WalletButton";
import { WhitelistPanel } from "./components/WhitelistPanel";
import { CHAINS, isSupportedChain, type SupportedChainId } from "./config/chains";
import { useAllocation, usePortfolio, useUserPositions, useUsdcMarkets } from "./hooks/useMarketData";
import { useRebalance } from "./hooks/useRebalance";
import { useWhitelist } from "./hooks/useWhitelist";

const CAP_FRACTION = 0.1;
const DEFAULT_WHITELIST_SIZE = 10;
const CHAIN_KEY = "morphoopti:chain";

function usePreviewAddress(): Address | undefined {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search).get("address")?.trim();
    return p && /^0x[0-9a-fA-F]{40}$/.test(p) ? (p as Address) : undefined;
  }, []);
}

function loadChain(): SupportedChainId {
  try {
    const n = Number(localStorage.getItem(CHAIN_KEY));
    if (isSupportedChain(n)) return n;
  } catch {
    // ignore
  }
  return 1;
}

export default function App() {
  const [chainId, setChainId] = useState<SupportedChainId>(loadChain);
  const chain = CHAINS[chainId];
  useEffect(() => {
    try {
      localStorage.setItem(CHAIN_KEY, String(chainId));
    } catch {
      // ignore
    }
  }, [chainId]);

  const { address: connectedAddress } = useAccount();
  // Read-only preview: ?address=0x… renders the allocation for any address without connecting.
  // The connected wallet always wins, and rebalancing stays disabled while previewing.
  const previewAddress = usePreviewAddress();
  const address = connectedAddress ?? previewAddress;

  const markets = useUsdcMarkets(chainId);
  const defaults = useMemo(
    () => markets.data?.slice(0, DEFAULT_WHITELIST_SIZE).map((m) => m.marketId as Hex),
    [markets.data],
  );
  const whitelist = useWhitelist(chainId, defaults);

  const positions = useUserPositions(chainId, address);
  const positionMarketIds = useMemo(() => {
    if (positions.data) return positions.data.map((p) => p.marketId);
    if (positions.isError) return [];
    return undefined;
  }, [positions.data, positions.isError]);

  const portfolio = usePortfolio({
    chainId,
    address,
    whitelistIds: whitelist.ids,
    apiMarkets: markets.data,
    positionMarketIds,
  });

  const allocation = useAllocation(portfolio.data, CAP_FRACTION);

  const onSettled = useCallback(() => {
    void positions.refetch();
    void portfolio.refetch();
  }, [positions, portfolio]);

  const rebalance = useRebalance({ chainId, portfolio: portfolio.data, allocation, onSettled });

  const rpcHint = !chain.rpcUrl;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>MorphoOpti</h1>
          <span className="muted">USDC allocator · Morpho Blue</span>
        </div>
        <ChainSelector value={chainId} onChange={setChainId} />
        <WalletButton />
      </header>

      {!connectedAddress && previewAddress && (
        <p className="warn-box tiny">
          Read-only preview of <span className="mono">{previewAddress}</span>. Connect that wallet to rebalance.
        </p>
      )}

      {rpcHint && (
        <p className="warn-box tiny">
          Using a public RPC for {chain.name}. Set <code>VITE_RPC_{chain.id === 1 ? "MAINNET" : "BASE"}</code> in <code>.env</code> for reliability.
        </p>
      )}

      <main className="grid">
        <div className="col left">
          <WhitelistPanel
            chain={chain}
            markets={markets.data}
            loading={markets.isLoading}
            error={markets.error}
            whitelist={whitelist}
            effectiveCap={allocation?.effectiveCapFraction ?? (whitelist.ids.length ? Math.max(CAP_FRACTION, 1 / whitelist.ids.length) : undefined)}
          />
        </div>
        <div className="col right">
          <AllocationTable
            chain={chain}
            portfolio={portfolio.data}
            allocation={allocation}
            loading={portfolio.isFetching || positions.isFetching}
            error={portfolio.error ?? positions.error}
            onRefresh={onSettled}
            fetchedAt={portfolio.data?.fetchedAt}
          />
          <RebalancePanel chain={chain} portfolio={portfolio.data} allocation={allocation} rebalance={rebalance} />
        </div>
      </main>
    </div>
  );
}
