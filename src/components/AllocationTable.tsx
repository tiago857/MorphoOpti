import { CHAINS, type SupportedChainId } from "../config/chains";
import type { AllocationResult } from "../core/optimizer";
import type { PoolPortfolio } from "../core/pools";
import { describeLiquidity, mergeLiquidityIssue } from "../core/liquidity";
import type { MarketAllocation } from "../core/optimizer";
import type { PortfolioMarket } from "../core/types";
import { fmtAmount, fmtApy, fmtDelta, fmtPct, fmtShare, shortAddr, unitsToNumber } from "../lib/format";
import { AlertIcon } from "./AlertIcon";

/** Everything wrong with one market in the plan: its live liquidity plus what the optimizer worked around. */
function marketIssues(a: MarketAllocation, m: PortfolioMarket | undefined): string[] {
  if (!m) return a.issues;
  const { totalSupplyAssets: s, totalBorrowAssets: b } = m.state;
  const text = describeLiquidity(unitsToNumber(s > b ? s - b : 0n), unitsToNumber(s), m.meta.loanSymbol);
  // Thin liquidity matters most when this plan is putting money in, so say how much.
  const note = text && a.delta > 0n ? `${text} This plan still moves ${fmtAmount(a.delta)} ${m.meta.loanSymbol} in.` : text;
  return mergeLiquidityIssue(note, a.issues);
}

interface Props {
  pool: PoolPortfolio;
  allocation: AllocationResult;
}

export function AllocationTable({ pool, allocation }: Props) {
  const chain = CHAINS[pool.chainId as SupportedChainId];
  const byId = new Map(pool.markets.map((m) => [m.id.toLowerCase(), m]));
  const vaultById = new Map(pool.vaults.map((v) => [v.id.toLowerCase(), v]));
  // Only markets that actually hold capital or are about to. A whitelisted market the optimizer
  // skipped is noise here — it belongs in the Markets list, not the allocation.
  const rows = allocation.markets
    .filter((a) => a.current > 0n || a.target > 0n)
    .sort((a, b) => {
      if (a.target !== b.target) return a.target > b.target ? -1 : 1;
      return a.current > b.current ? -1 : 1;
    });
  const skipped = allocation.markets.length - rows.length;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="label">Pool</span>
          <span className="value">
            {fmtAmount(allocation.total)} {pool.symbol}
          </span>
        </div>
        {allocation.idle > 0n && (
          <div className="stat">
            <span className="label">of which from wallet</span>
            <span className="value">
              {fmtAmount(allocation.idle)} {pool.symbol}
            </span>
          </div>
        )}
        <div className="stat">
          {/* Idle capital earns nothing today, so it counts at 0% here; otherwise "now" and "after"
              would be averages over different amounts of money. */}
          <span className="label">{allocation.idle > 0n ? "APY now (idle at 0%)" : "APY now"}</span>
          <span className="value">{fmtPct(allocation.portfolioApyNow)}</span>
        </div>
        <div className="stat">
          <span className="label">APY after rebalance</span>
          <span className={`value ${allocation.portfolioApyProjected >= allocation.portfolioApyNow ? "good" : "warn"}`}>
            {fmtPct(allocation.portfolioApyProjected)}
          </span>
        </div>
        <div className="stat">
          <span className="label">Default cap</span>
          {/* A cap of 100% means too few markets are whitelisted for it, so it is switched off. */}
          <span className="value">
            {allocation.effectiveCapFraction >= 1 ? "off" : fmtPct(allocation.effectiveCapFraction, 1)}
          </span>
        </div>
      </div>

      {allocation.warnings.map((w) => (
        <p key={w} className="warn-box">
          {w}
        </p>
      ))}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th className="num">Current → target</th>
              <th className="num">Move</th>
              <th className="num">APY now → target</th>
              <th className="num">Liquidity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const key = a.id.toLowerCase();
              const m = byId.get(key);
              const vault = vaultById.get(key);
              const liquidity = m ? m.state.totalSupplyAssets - m.state.totalBorrowAssets : vault?.totalAssets ?? 0n;
              return (
                <tr key={a.id} className={a.delta === 0n ? "" : a.delta > 0n ? "in" : "out"}>
                  <td>
                    <div>
                      <a
                        href={`https://app.morpho.org/${chain.name.toLowerCase()}/${vault ? "vault" : "market"}/${a.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {vault?.name ?? m?.meta.collateralSymbol ?? shortAddr(a.id)}
                      </a>{" "}
                      <AlertIcon issues={marketIssues(a, m)} />{" "}
                      {vault ? (
                        <span className="badge vault-badge">VAULT</span>
                      ) : (
                        <span className="muted tiny">{m ? fmtPct(m.meta.lltv, 0) : ""}</span>
                      )}
                      {vault && vault.fee > 0 && <span className="muted tiny">net of {fmtPct(vault.fee, 0)} fee</span>}
                      {!a.whitelisted && !a.pinned && <span className="badge warn">not whitelisted</span>}
                    </div>
                    <div className="mono tiny muted" title={a.id}>
                      {shortAddr(a.id)}
                    </div>
                  </td>
                  <td className="num">
                    <div>
                      {fmtAmount(a.current)} <span className="muted">→</span> <strong>{fmtAmount(a.target)}</strong>
                    </div>
                    <div className="tiny muted">
                      {fmtShare(a.current, allocation.total)} → {fmtShare(a.target, allocation.total)}
                    </div>
                  </td>
                  <td className={`num mono ${a.delta > 0n ? "good" : a.delta < 0n ? "warn" : "muted"}`}>
                    {fmtDelta(a.delta)}
                  </td>
                  <td className="num">
                    <div>
                      {fmtApy(a.currentApy)} <span className="muted">→</span>{" "}
                      <span className={a.projectedApy >= a.currentApy ? "good" : "warn"}>{fmtApy(a.projectedApy)}</span>
                    </div>
                    {a.projectedRewardApr > 0 && (
                      <div className="tiny muted">incl. {fmtApy(a.projectedRewardApr)} rewards</div>
                    )}
                  </td>
                  <td className="num">
                    <div>{fmtAmount(liquidity, 0)}</div>
                    {a.locked > 0n && <div className="tiny warn">locked {fmtAmount(a.locked, 0)}</div>}
                    {a.liquidityFloor > 0n && <div className="tiny warn">floor {fmtAmount(a.liquidityFloor, 0)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {skipped > 0 && (
        <p className="tiny muted">
          {skipped} whitelisted {skipped === 1 ? "market holds" : "markets hold"} nothing and receive nothing; they stay
          in the Markets list.
        </p>
      )}
    </>
  );
}
