import { useSwitchChain } from "wagmi";
import type { ChainConfig } from "../config/chains";
import type { AllocationResult } from "../core/optimizer";
import type { Portfolio } from "../core/types";
import type { useRebalance } from "../hooks/useRebalance";
import { fmtUsdc, shortAddr } from "../lib/format";

interface Props {
  chain: ChainConfig;
  portfolio: Portfolio | undefined;
  allocation: AllocationResult | undefined;
  rebalance: ReturnType<typeof useRebalance>;
}

export function RebalancePanel({ chain, portfolio, allocation, rebalance }: Props) {
  const { switchChain, isPending: switching } = useSwitchChain();
  const { phase, authPhase, bundle, bundleError } = rebalance;
  const byId = new Map(portfolio?.markets.map((m) => [m.id.toLowerCase(), m]) ?? []);
  const busy = phase.kind === "simulating" || phase.kind === "awaiting-wallet" || phase.kind === "pending";

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Rebalance</h2>
        <span className="muted">one atomic transaction via Morpho Bundler3</span>
      </header>

      {!rebalance.connected && <p className="muted">Connect your Fordefi wallet to rebalance.</p>}

      {rebalance.connected && rebalance.wrongChain && (
        <div className="row gap">
          <span>Your wallet is on another network.</span>
          <button className="primary" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
            Switch to {chain.name}
          </button>
        </div>
      )}

      {rebalance.connected && !rebalance.wrongChain && portfolio && !portfolio.isAuthorized && (
        <div className="notice">
          <p>
            One-time setup: allow Morpho's <a href={chain.explorerAddress(chain.generalAdapter1)} target="_blank" rel="noreferrer">GeneralAdapter1</a>{" "}
            to withdraw on your behalf. This is Morpho's own bundler adapter; it can only move positions for the account that
            initiates the bundle and never holds funds between transactions. No token approvals are needed.
          </p>
          <div className="row gap">
            <button className="primary" disabled={authPhase.kind !== "idle" && authPhase.kind !== "error"} onClick={rebalance.authorize}>
              {authPhase.kind === "awaiting-wallet" ? "Approve in Fordefi…" : authPhase.kind === "pending" ? "Confirming…" : "Authorize adapter"}
            </button>
            {authPhase.kind === "pending" && (
              <a href={chain.explorerTx(authPhase.hash)} target="_blank" rel="noreferrer">
                view tx
              </a>
            )}
            {authPhase.kind === "error" && <span className="error">{authPhase.message}</span>}
          </div>
        </div>
      )}

      {rebalance.connected && !rebalance.wrongChain && portfolio?.isAuthorized && allocation && !allocation.hasChanges && (
        <p className="good">Portfolio is already at target. Nothing to do.</p>
      )}

      {bundleError && <p className="error">{bundleError}</p>}

      {rebalance.connected && !rebalance.wrongChain && portfolio?.isAuthorized && bundle && (
        <>
          <ol className="steps">
            {bundle.steps.map((s, i) => {
              const m = s.marketId ? byId.get(s.marketId.toLowerCase()) : undefined;
              const name = m ? `${m.meta.collateralSymbol} / USDC` : s.marketId ? shortAddr(s.marketId) : "";
              if (s.kind === "withdraw")
                return (
                  <li key={i}>
                    Withdraw <b>{s.amount === "max" ? "entire position" : `${fmtUsdc(s.amount)} USDC`}</b> from {name}
                    {s.fullExit && s.amount === "max" && m ? ` (~${fmtUsdc(m.supplyAssets)} USDC)` : ""}
                  </li>
                );
              if (s.kind === "supply")
                return (
                  <li key={i}>
                    Supply <b>{s.amount === "max" ? "remaining balance" : `${fmtUsdc(s.amount)} USDC`}</b> to {name}
                  </li>
                );
              return (
                <li key={i} className="muted">
                  Return any leftover USDC to your wallet (safety skim)
                </li>
              );
            })}
          </ol>

          <div className="row gap wrap">
            <button className="ghost" disabled={busy} onClick={rebalance.simulate}>
              {phase.kind === "simulating" ? "Simulating…" : "Simulate"}
            </button>
            <button
              className="primary big"
              disabled={phase.kind !== "ready"}
              onClick={rebalance.execute}
              title={phase.kind !== "ready" ? "Run a successful simulation first" : "Send the bundle to Fordefi"}
            >
              {phase.kind === "awaiting-wallet" ? "Approve in Fordefi…" : phase.kind === "pending" ? "Confirming…" : "Rebalance"}
            </button>
            {phase.kind === "ready" && <span className="muted">gas ≈ {phase.gas.toLocaleString()}</span>}
          </div>

          {phase.kind === "sim-error" && <p className="error">Simulation failed: {phase.message}</p>}
          {phase.kind === "awaiting-wallet" && (
            <p className="muted">Waiting for Fordefi. Approve the transaction in the extension and, if your policy requires it, in the mobile app.</p>
          )}
          {phase.kind === "pending" && (
            <p>
              Broadcast.{" "}
              <a href={chain.explorerTx(phase.hash)} target="_blank" rel="noreferrer">
                {shortAddr(phase.hash)}
              </a>{" "}
              waiting for confirmation…
            </p>
          )}
          {phase.kind === "mined" && (
            <p className={phase.success ? "good" : "error"}>
              {phase.success ? "Rebalance confirmed." : "Transaction reverted."}{" "}
              <a href={chain.explorerTx(phase.hash)} target="_blank" rel="noreferrer">
                {shortAddr(phase.hash)}
              </a>
            </p>
          )}
          {phase.kind === "error" && (
            <p className="error">
              {phase.message}{" "}
              <button className="ghost" onClick={rebalance.reset}>
                dismiss
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
