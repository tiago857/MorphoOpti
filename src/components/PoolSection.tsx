import { useState } from "react";
import { CHAINS, type SupportedChainId } from "../config/chains";
import type { AllocationResult } from "../core/optimizer";
import type { PoolPortfolio } from "../core/pools";
import { useRebalance } from "../hooks/useRebalance";
import { fmtAmount, fmtPct } from "../lib/format";
import { AllocationTable } from "./AllocationTable";
import { RebalancePanel } from "./RebalancePanel";

interface Props {
  pool: PoolPortfolio;
  allocation: AllocationResult;
  onSettled: () => void;
  /** Read-only preview mode: an address is loaded but no wallet is connected. */
  previewOnly: boolean;
  /** Whether idle wallet capital is being deployed into this pool. */
  idleEnabled: boolean;
  onToggleIdle: () => void;
}

/**
 * One (chain, loan asset) pool: its allocation and its own rebalance transaction. Each pool owns a
 * `useRebalance` instance, which is why pools render as components rather than in a loop in App.
 */
export function PoolSection({ pool, allocation, onSettled, previewOnly, idleEnabled, onToggleIdle }: Props) {
  const chain = CHAINS[pool.chainId as SupportedChainId];
  const [open, setOpen] = useState(true);
  const rebalance = useRebalance({ pool, allocation, onSettled });
  const walletBalance = pool.wallet?.balance ?? 0n;

  // Caps are a risk constraint, so rebalancing can legitimately *lower* yield when capital sits
  // concentrated in one good market. Say so plainly rather than calling a loss a gain.
  const gain = allocation.portfolioApyProjected - allocation.portfolioApyNow;
  const change = !allocation.hasChanges
    ? "at target"
    : `${fmtPct(allocation.portfolioApyNow)} → ${fmtPct(allocation.portfolioApyProjected)}`;

  return (
    <section className="panel pool">
      <header className="panel-head" onClick={() => setOpen((o) => !o)}>
        <h2>
          <span className="pool-symbol">{pool.symbol}</span>
          <span className="badge">{chain.name}</span>
        </h2>
        <span className="muted">
          {fmtAmount(pool.total, 0)} {pool.symbol}
          {(pool.idle ?? 0n) > 0n ? ` + ${fmtAmount(pool.idle ?? 0n, 0)} idle` : ""} · {pool.markets.length} markets ·{" "}
          <span className={allocation.hasChanges ? (gain >= 0 ? "good" : "warn") : undefined}>{change}</span>
        </span>
        <button className="ghost" aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </button>
      </header>

      {open && (
        <>
          {walletBalance >= 1_000_000n && (
            <label className="idle-toggle">
              <input type="checkbox" checked={idleEnabled} onChange={onToggleIdle} />
              <span>
                Deploy idle wallet {pool.symbol}{" "}
                <strong>
                  {fmtAmount(walletBalance)} {pool.symbol}
                </strong>
              </span>
              <span className="tiny muted">
                {idleEnabled
                  ? "Added to the capital already deployed and allocated with it. Needs a one-off approval of this amount."
                  : "Off: only capital already in Morpho is rebalanced."}
              </span>
            </label>
          )}
          <AllocationTable pool={pool} allocation={allocation} />
          {previewOnly ? (
            <p className="muted tiny">Read-only preview. Connect this wallet to rebalance.</p>
          ) : (
            <RebalancePanel pool={pool} allocation={allocation} rebalance={rebalance} />
          )}
        </>
      )}
    </section>
  );
}
