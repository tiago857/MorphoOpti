import { CHAINS, type SupportedChainId } from "../config/chains";
import type { AllocationResult } from "../core/optimizer";
import type { PoolPortfolio } from "../core/pools";
import type { useRebalance } from "../hooks/useRebalance";
import { fmtAmount, shortAddr } from "../lib/format";

interface Props {
  pool: PoolPortfolio;
  allocation: AllocationResult | undefined;
  rebalance: ReturnType<typeof useRebalance>;
}

export function RebalancePanel({ pool, allocation, rebalance }: Props) {
  const chain = CHAINS[pool.chainId as SupportedChainId];
  const { phase, authPhase, bundle, bundleError } = rebalance;
  const symbol = pool.symbol;
  const byId = new Map(pool.markets.map((m) => [m.id.toLowerCase(), m]));
  const vaultById = new Map(pool.vaults.map((v) => [v.id.toLowerCase(), v]));
  const approvals = rebalance.pendingApprovals;
  const tokenApproval = rebalance.tokenApproval;
  // Any outstanding allowance blocks simulation: the bundle would revert pulling tokens it may not take.
  const blocked = approvals.length > 0 || tokenApproval !== undefined;
  // Market withdrawals need Morpho authorization; a vault-only bundle does not.
  const authOk = pool.isAuthorized || !rebalance.needsMorphoAuth;
  const busy = phase.kind === "simulating" || phase.kind === "awaiting-wallet" || phase.kind === "pending";

  return (
    <div className="rebalance">
      <header className="sub-head">
        <h3>Rebalance {symbol}</h3>
        <span className="muted tiny">one atomic transaction via Morpho Bundler3 on {chain.name}</span>
      </header>

      {!rebalance.connected && <p className="muted">Connect your Fordefi wallet to rebalance.</p>}

      {rebalance.connected && rebalance.wrongChain && (
        <div className="row gap">
          <span>This pool is on {chain.name}; your wallet is on another network.</span>
          <button className="primary" onClick={rebalance.switchToChain}>
            Switch to {chain.name}
          </button>
        </div>
      )}

      {rebalance.connected && !rebalance.wrongChain && !authOk && (
        <div className="notice">
          <p>
            One-time setup: allow Morpho's{" "}
            <a href={chain.explorerAddress(chain.generalAdapter1)} target="_blank" rel="noreferrer">
              GeneralAdapter1
            </a>{" "}
            to withdraw on your behalf. This is Morpho's own bundler adapter; it can only move positions for the account
            that initiates the bundle and never holds funds between transactions. One authorization covers every pool
            on {chain.name}. Market legs need no token approval; only exiting a vault does, and it is asked for
            separately.
          </p>
          <div className="row gap">
            <button
              className="primary"
              disabled={authPhase.kind !== "idle" && authPhase.kind !== "error"}
              onClick={rebalance.authorize}
            >
              {authPhase.kind === "awaiting-wallet"
                ? "Approve in Fordefi…"
                : authPhase.kind === "pending"
                  ? "Confirming…"
                  : "Authorize adapter"}
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

      {rebalance.connected && !rebalance.wrongChain && authOk && allocation && !allocation.hasChanges && (
        <p className="good">This pool is already at target. Nothing to do.</p>
      )}

      {bundleError && <p className="error">{bundleError}</p>}

      {rebalance.connected && !rebalance.wrongChain && approvals.length > 0 && (
        <div className="notice">
          <p>
            This rebalance exits {approvals.length === 1 ? "a vault" : `${approvals.length} vaults`}, which means the
            adapter has to pull your vault shares. Approve each one for exactly the shares being redeemed — no standing
            allowance is left behind. Depositing into a vault needs nothing.
          </p>
          <div className="row gap wrap">
            {approvals.map((a) => {
              const v = vaultById.get(a.vault.toLowerCase());
              return (
                <button
                  key={a.vault}
                  className="primary"
                  disabled={authPhase.kind === "awaiting-wallet" || authPhase.kind === "pending"}
                  onClick={() => rebalance.approveVault(a.vault, a.shares)}
                >
                  Approve {v?.name ?? shortAddr(a.vault)}
                </button>
              );
            })}
            {authPhase.kind === "error" && <span className="error">{authPhase.message}</span>}
          </div>
        </div>
      )}

      {rebalance.connected && !rebalance.wrongChain && tokenApproval && (
        <div className="notice">
          <p>
            Deploying idle {symbol} means the adapter pulls it from your wallet. Approve GeneralAdapter1 for{" "}
            <b>
              {fmtAmount(tokenApproval.amount)} {symbol}
            </b>{" "}
            — the idle balance you chose to deploy, not an unlimited allowance.
          </p>
          <div className="row gap wrap">
            <button
              className="primary"
              disabled={authPhase.kind === "awaiting-wallet" || authPhase.kind === "pending"}
              onClick={rebalance.approveToken}
            >
              {authPhase.kind === "awaiting-wallet"
                ? "Approve in Fordefi…"
                : authPhase.kind === "pending"
                  ? "Confirming…"
                  : `Approve ${fmtAmount(tokenApproval.amount)} ${symbol}`}
            </button>
            {authPhase.kind === "error" && <span className="error">{authPhase.message}</span>}
          </div>
        </div>
      )}

      {rebalance.connected && !rebalance.wrongChain && authOk && bundle && (
        <>
          <ol className="steps">
            {bundle.steps.map((s, i) => {
              const m = s.marketId ? byId.get(s.marketId.toLowerCase()) : undefined;
              const v = s.vault ? vaultById.get(s.vault.toLowerCase()) : undefined;
              const name = v
                ? `${v.name} (vault)`
                : m
                  ? `${m.meta.collateralSymbol} / ${symbol}`
                  : s.marketId
                    ? shortAddr(s.marketId)
                    : "";
              if (s.kind === "wallet-pull")
                return (
                  <li key={i}>
                    Pull{" "}
                    <b>
                      {s.amount === "max" ? "idle balance" : `${fmtAmount(s.amount)} ${symbol}`}
                    </b>{" "}
                    from your wallet
                  </li>
                );
              if (s.kind === "vault-redeem")
                return (
                  <li key={i}>
                    Redeem <b>{s.amount === "max" ? "entire position" : `${fmtAmount(s.amount)} ${symbol}`}</b> from{" "}
                    {name}
                  </li>
                );
              if (s.kind === "vault-deposit")
                return (
                  <li key={i}>
                    Deposit <b>{s.amount === "max" ? "remaining balance" : `${fmtAmount(s.amount)} ${symbol}`}</b> into{" "}
                    {name}
                  </li>
                );
              if (s.kind === "withdraw")
                return (
                  <li key={i}>
                    Withdraw <b>{s.amount === "max" ? "entire position" : `${fmtAmount(s.amount)} ${symbol}`}</b> from{" "}
                    {name}
                    {s.fullExit && s.amount === "max" && m ? ` (~${fmtAmount(m.supplyAssets)} ${symbol})` : ""}
                  </li>
                );
              if (s.kind === "supply")
                return (
                  <li key={i}>
                    Supply <b>{s.amount === "max" ? "remaining balance" : `${fmtAmount(s.amount)} ${symbol}`}</b> to{" "}
                    {name}
                  </li>
                );
              return (
                <li key={i} className="muted">
                  Return any leftover {symbol} to your wallet (safety skim)
                </li>
              );
            })}
          </ol>

          <div className="row gap wrap">
            <button className="ghost" disabled={busy || blocked} onClick={rebalance.simulate}>
              {phase.kind === "simulating" ? "Simulating…" : "Simulate"}
            </button>
            <button
              className="primary big"
              disabled={phase.kind !== "ready" || blocked}
              onClick={rebalance.execute}
              title={phase.kind !== "ready" ? "Run a successful simulation first" : "Send the bundle to Fordefi"}
            >
              {phase.kind === "awaiting-wallet"
                ? "Approve in Fordefi…"
                : phase.kind === "pending"
                  ? "Confirming…"
                  : `Rebalance ${symbol}`}
            </button>
            {phase.kind === "ready" && <span className="muted">gas ≈ {phase.gas.toLocaleString()}</span>}
            {/* Say why the button is dead rather than leaving it greyed out with no explanation. */}
            {phase.kind !== "ready" && !blocked && !busy && (
              <span className="muted tiny">Simulate first — Rebalance unlocks once the bundle is proven to execute.</span>
            )}
            {tokenApproval && <span className="muted tiny">Approve the {symbol} above first.</span>}
            {approvals.length > 0 && (
              <span className="muted tiny">Approve the vault share{approvals.length > 1 ? "s" : ""} above first.</span>
            )}
          </div>

          {phase.kind === "sim-error" && <p className="error">Simulation failed: {phase.message}</p>}
          {phase.kind === "awaiting-wallet" && (
            <p className="muted">
              Waiting for Fordefi. Approve the transaction in the extension and, if your policy requires it, in the
              mobile app.
            </p>
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
    </div>
  );
}
