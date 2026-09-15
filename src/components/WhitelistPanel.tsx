import { useMemo, useState } from "react";
import type { Hex } from "viem";
import type { ChainConfig } from "../config/chains";
import type { ApiMarket } from "../data/morphoApi";
import { rewardApr } from "../data/morphoApi";
import type { useWhitelist } from "../hooks/useWhitelist";
import { fmtPct, fmtUsdCompact, shortAddr } from "../lib/format";

interface Props {
  chain: ChainConfig;
  markets: ApiMarket[] | undefined;
  loading: boolean;
  error: Error | null;
  whitelist: ReturnType<typeof useWhitelist>;
  effectiveCap: number | undefined;
}

export function WhitelistPanel({ chain, markets, loading, error, whitelist, effectiveCap }: Props) {
  const [filter, setFilter] = useState("");
  const [manualId, setManualId] = useState("");

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = markets ?? [];
    return q
      ? list.filter(
          (m) => m.collateralAsset?.symbol.toLowerCase().includes(q) || m.marketId.toLowerCase().includes(q),
        )
      : list;
  }, [markets, filter]);

  const known = useMemo(() => new Set((markets ?? []).map((m) => m.marketId.toLowerCase())), [markets]);
  const manualIds = whitelist.ids.filter((id) => !known.has(id.toLowerCase()));

  const addManual = () => {
    const id = manualId.trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(id)) {
      whitelist.add(id as Hex);
      setManualId("");
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Whitelist</h2>
        <span className="muted">
          {whitelist.ids.length} markets
          {effectiveCap !== undefined && whitelist.ids.length > 0 ? ` · cap ${fmtPct(effectiveCap, 1)} each` : ""}
        </span>
        <button className="ghost" onClick={whitelist.reset} title="Reset to the 10 largest markets">
          Reset
        </button>
      </header>

      <div className="row gap">
        <input placeholder="Filter by collateral…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      {loading && <p className="muted">Loading markets…</p>}
      {error && <p className="error">Morpho API: {error.message}</p>}

      <div className="scroll">
        <table className="compact">
          <thead>
            <tr>
              <th></th>
              <th>Collateral</th>
              <th className="num">LLTV</th>
              <th className="num">Supplied</th>
              <th className="num">Util</th>
              <th className="num">APY</th>
              <th className="num">Rewards</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const on = whitelist.set.has(m.marketId.toLowerCase());
              const rw = rewardApr(m);
              return (
                <tr key={m.marketId} className={on ? "on" : ""} onClick={() => whitelist.toggle(m.marketId)}>
                  <td>
                    <input type="checkbox" checked={on} readOnly />
                  </td>
                  <td>
                    <div>{m.collateralAsset?.symbol ?? "?"}</div>
                    <div className="mono tiny muted" title={m.marketId}>
                      {shortAddr(m.marketId)}
                    </div>
                  </td>
                  <td className="num">{fmtPct(Number(m.lltv) / 1e18, 0)}</td>
                  <td className="num">{fmtUsdCompact(m.state?.supplyAssetsUsd ?? 0)}</td>
                  <td className="num">{fmtPct(m.state?.utilization ?? 0, 0)}</td>
                  <td className="num">{fmtPct(m.state?.supplyApy ?? 0)}</td>
                  <td className="num">{rw > 0 ? fmtPct(rw) : "—"}</td>
                </tr>
              );
            })}
            {manualIds.map((id) => (
              <tr key={id} className="on" onClick={() => whitelist.toggle(id)}>
                <td>
                  <input type="checkbox" checked readOnly />
                </td>
                <td colSpan={6}>
                  <span className="mono tiny">{id}</span> <span className="badge">by id</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row gap">
        <input
          className="mono"
          placeholder="Add market by id (0x…64 hex)"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addManual()}
        />
        <button className="ghost" onClick={addManual} disabled={!/^0x[0-9a-fA-F]{64}$/.test(manualId.trim())}>
          Add
        </button>
      </div>
      <p className="tiny muted">
        Listed USDC markets on {chain.name} from the Morpho API. Optimizer rates and positions are read on-chain.
      </p>
    </section>
  );
}
