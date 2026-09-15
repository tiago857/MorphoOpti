import type { ChainConfig } from "../config/chains";
import type { AllocationResult } from "../core/optimizer";
import type { Portfolio } from "../core/types";
import { fmtDelta, fmtPct, fmtShare, fmtUsdc, shortAddr } from "../lib/format";

interface Props {
  chain: ChainConfig;
  portfolio: Portfolio | undefined;
  allocation: AllocationResult | undefined;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  fetchedAt: number | undefined;
}

export function AllocationTable({ chain, portfolio, allocation, loading, error, onRefresh, fetchedAt }: Props) {
  const byId = new Map(portfolio?.markets.map((m) => [m.id.toLowerCase(), m]) ?? []);
  const rows = [...(allocation?.markets ?? [])].sort((a, b) => {
    if (a.target !== b.target) return a.target > b.target ? -1 : 1;
    return a.current > b.current ? -1 : 1;
  });

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Allocation</h2>
        <span className="muted">
          {fetchedAt ? `updated ${new Date(fetchedAt).toLocaleTimeString()}` : ""}
          {loading ? " · refreshing…" : ""}
        </span>
        <button className="ghost" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && <p className="error">{error.message}</p>}
      {!portfolio && !error && <p className="muted">Connect a wallet to load positions.</p>}

      {allocation && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="label">Portfolio</span>
              <span className="value">{fmtUsdc(allocation.total)} USDC</span>
            </div>
            <div className="stat">
              <span className="label">APY now</span>
              <span className="value">{fmtPct(allocation.portfolioApyNow)}</span>
            </div>
            <div className="stat">
              <span className="label">APY after rebalance</span>
              <span className={`value ${allocation.portfolioApyProjected >= allocation.portfolioApyNow ? "good" : "warn"}`}>
                {fmtPct(allocation.portfolioApyProjected)}
              </span>
            </div>
            <div className="stat">
              <span className="label">Cap per market</span>
              <span className="value">{fmtPct(allocation.effectiveCapFraction, 1)}</span>
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
                  <th className="num">Current</th>
                  <th className="num">Target</th>
                  <th className="num">Move</th>
                  <th className="num">APY now</th>
                  <th className="num">APY target</th>
                  <th className="num">Liquidity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const m = byId.get(a.id.toLowerCase());
                  const liquidity = m ? m.state.totalSupplyAssets - m.state.totalBorrowAssets : 0n;
                  return (
                    <tr key={a.id} className={a.delta === 0n ? "" : a.delta > 0n ? "in" : "out"}>
                      <td>
                        <div>
                          <a href={`https://app.morpho.org/${chain.name.toLowerCase()}/market/${a.id}`} target="_blank" rel="noreferrer">
                            {m?.meta.collateralSymbol ?? shortAddr(a.id)}
                          </a>{" "}
                          <span className="muted tiny">{m ? fmtPct(m.meta.lltv, 0) : ""}</span>
                          {!a.whitelisted && !a.pinned && <span className="badge warn">not whitelisted</span>}
                          {a.pinned && <span className="badge warn">held (custom IRM)</span>}
                        </div>
                        <div className="mono tiny muted" title={a.id}>
                          {shortAddr(a.id)}
                        </div>
                      </td>
                      <td className="num">
                        <div>{fmtUsdc(a.current)}</div>
                        <div className="tiny muted">{fmtShare(a.current, allocation.total)}</div>
                      </td>
                      <td className="num">
                        <div>{fmtUsdc(a.target)}</div>
                        <div className="tiny muted">{fmtShare(a.target, allocation.total)}</div>
                      </td>
                      <td className={`num mono ${a.delta > 0n ? "good" : a.delta < 0n ? "warn" : "muted"}`}>{fmtDelta(a.delta)}</td>
                      <td className="num">
                        <div>{fmtPct(a.currentApy)}</div>
                        {a.currentRewardApr > 0 && <div className="tiny muted">incl. {fmtPct(a.currentRewardApr)} rewards</div>}
                      </td>
                      <td className="num">
                        <div>{fmtPct(a.projectedApy)}</div>
                        {a.projectedRewardApr > 0 && <div className="tiny muted">incl. {fmtPct(a.projectedRewardApr)} rewards</div>}
                      </td>
                      <td className="num">
                        <div>{fmtUsdc(liquidity, 0)}</div>
                        {a.liquidityFloor > 0n && <div className="tiny warn">floor {fmtUsdc(a.liquidityFloor, 0)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
