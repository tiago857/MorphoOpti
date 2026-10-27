import { useMemo, useState } from "react";
import type { Hex } from "viem";
import { CHAINS, type SupportedChainId } from "../config/chains";
import { applyFilters, filterOptions, type FilterableMarket, type MarketFilters } from "../core/filters";
import { nextSort, sortMarkets, type MarketSort, type SortKey, type SortableMarket } from "../core/sort";
import { rewardApr, vaultRewardApr, type ApiMarket, type ApiVault } from "../data/morphoApi";
import { describeLiquidity, mergeLiquidityIssue } from "../core/liquidity";
import { vaultNetApy } from "../core/vault";
import type { ChainMarket, ChainVault } from "../hooks/useMarketData";
import { parseUnits6, type useMarketSettings } from "../hooks/useMarketSettings";
import type { useWhitelist } from "../hooks/useWhitelist";
import { fmtApy, fmtPct, fmtUsdCompact, shortAddr } from "../lib/format";
import { AlertIcon } from "./AlertIcon";
import { MarketFiltersBar } from "./MarketFiltersBar";

interface Props {
  rows: ChainMarket[];
  vaultRows: ChainVault[];
  loading: boolean;
  error: Error | null;
  filters: MarketFilters;
  onFiltersChange: (f: MarketFilters) => void;
  sort: MarketSort;
  onSortChange: (s: MarketSort) => void;
  /** Whitelist hook per chain — markets are whitelisted against the chain they live on. */
  whitelists: Record<SupportedChainId, ReturnType<typeof useWhitelist>>;
  settings: ReturnType<typeof useMarketSettings>;
  /** Per-market problems from the latest allocation, keyed `${chainId}:${lowercased id}`. */
  issues: Record<string, string[]>;
}

const NO_ISSUES: string[] = [];

/** A row in the list is either a market or a vault; both filter and sort through the same shape. */
type Venue = { kind: "market"; row: ChainMarket } | { kind: "vault"; row: ChainVault };
type Row = FilterableMarket & SortableMarket & { venue: Venue };

/**
 * A vault mapped onto the market row shape. It has no collateral and no LLTV, and its "APY" is the
 * yield after the vault's fee, so the Total column stays comparable with a market's.
 */
function toFilterableVault(row: ChainVault): Row {
  const v = row.vault;
  const baseApy = v.state?.apy ?? 0;
  const fee = v.state?.fee ?? 0;
  const rewards = vaultRewardApr(v);
  return {
    venue: { kind: "vault", row },
    id: v.address,
    chainId: row.chainId,
    loanSymbol: v.asset.symbol,
    collateralSymbol: v.name,
    lltv: NaN, // a vault has no liquidation LTV
    supplyUsd: v.state?.totalAssetsUsd ?? 0,
    // A vault's free liquidity depends on its underlying markets; treat it as available so the
    // liquidity floor never hides a vault for a reason we cannot actually verify here.
    liquidityUsd: v.state?.totalAssetsUsd ?? 0,
    utilization: NaN,
    apy: baseApy * (1 - fee),
    rewardApr: rewards,
  };
}

/** Map an API market onto the shape the filters and the sorter understand. */
function toFilterable(row: ChainMarket): Row {
  const m = row.market;
  const supplyUsd = m.state?.supplyAssetsUsd ?? 0;
  const supplyAssets = Number(m.state?.supplyAssets ?? 0);
  // liquidityAssets is in token units; convert to USD with the market's own USD-per-unit ratio so the
  // filter compares like with like even for a depegged asset.
  const perUnit = supplyAssets > 0 ? supplyUsd / supplyAssets : 0;
  return {
    venue: { kind: "market", row },
    id: m.marketId,
    chainId: row.chainId,
    loanSymbol: m.loanAsset.symbol,
    collateralSymbol: m.collateralAsset?.symbol ?? "?",
    lltv: Number(m.lltv) / 1e18,
    supplyUsd,
    liquidityUsd: Number(m.state?.liquidityAssets ?? 0) * perUnit,
    utilization: m.state?.utilization ?? 0,
    apy: m.state?.supplyApy ?? 0,
    rewardApr: rewardApr(m),
  };
}

export function WhitelistPanel({
  rows,
  vaultRows,
  loading,
  error,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  whitelists,
  settings,
  issues,
}: Props) {
  const [manualId, setManualId] = useState("");
  const [manualChain, setManualChain] = useState<SupportedChainId>(1);

  const filterable = useMemo(
    () => [...rows.map(toFilterable), ...vaultRows.map(toFilterableVault)],
    [rows, vaultRows],
  );
  const options = useMemo(() => filterOptions(filterable), [filterable]);
  const visible = useMemo(
    () => sortMarkets(applyFilters(filterable, filters), sort),
    [filterable, filters, sort],
  );

  const totalWhitelisted = useMemo(
    () => Object.values(whitelists).reduce((acc, w) => acc + w.ids.length, 0),
    [whitelists],
  );

  const known = useMemo(
    () =>
      new Set([
        ...rows.map((r) => `${r.chainId}:${r.market.marketId.toLowerCase()}`),
        ...vaultRows.map((r) => `${r.chainId}:${r.vault.address.toLowerCase()}`),
      ]),
    [rows, vaultRows],
  );
  const manualEntries = useMemo(
    () =>
      (Object.keys(whitelists) as unknown as SupportedChainId[]).flatMap((chainId) =>
        whitelists[chainId].ids
          .filter((id) => !known.has(`${chainId}:${id.toLowerCase()}`))
          .map((id) => ({ chainId, id })),
      ),
    [whitelists, known],
  );

  const addManual = () => {
    const id = manualId.trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(id)) {
      whitelists[manualChain].add(id as Hex);
      setManualId("");
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Markets</h2>
        <span className="muted">
          {totalWhitelisted} whitelisted · default cap {settings.settings.defaultCapPct}%
          {settings.overrideCount > 0 ? ` · ${settings.overrideCount} overridden` : ""}
        </span>
        <label className="cap-default">
          Cap
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={settings.settings.defaultCapPct}
            onChange={(e) => settings.setDefaultCapPct(Number(e.target.value))}
          />
          %
        </label>
        <button className="ghost" onClick={settings.resetAll} title="Clear all cap and locked overrides">
          Reset caps
        </button>
      </header>

      <MarketFiltersBar
        filters={filters}
        options={options}
        onChange={onFiltersChange}
        matched={visible.length}
        total={filterable.length}
      />

      {loading && <p className="muted">Loading markets…</p>}
      {error && <p className="error">Morpho API: {error.message}</p>}

      <div className="scroll tall">
        <table className="compact">
          <thead>
            <tr>
              <th></th>
              <SortHeader label="Collateral / deposit" sortKey="name" sort={sort} onSortChange={onSortChange} />
              <SortHeader label="LLTV" sortKey="lltv" sort={sort} onSortChange={onSortChange} num />
              <SortHeader label="Supplied" sortKey="supply" sort={sort} onSortChange={onSortChange} num />
              <SortHeader label="Util" sortKey="utilization" sort={sort} onSortChange={onSortChange} num />
              <SortHeader label="APY" sortKey="apy" sort={sort} onSortChange={onSortChange} num />
              <SortHeader
                label="Total"
                sortKey="totalApy"
                sort={sort}
                onSortChange={onSortChange}
                num
                title="Supply APY plus rewards — the yield you actually earn"
              />
              <th className="num">Cap</th>
              <th className="num">Locked</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) =>
              f.venue.kind === "vault" ? (
                <VaultRow
                  key={`${f.chainId}:${f.id}`}
                  chainId={f.venue.row.chainId}
                  vault={f.venue.row.vault}
                  whitelist={whitelists[f.venue.row.chainId]}
                  settings={settings}
                  issues={issues[`${f.chainId}:${f.id.toLowerCase()}`] ?? NO_ISSUES}
                />
              ) : (
                <MarketRow
                  key={`${f.chainId}:${f.id}`}
                  chainId={f.venue.row.chainId}
                  market={f.venue.row.market}
                  whitelist={whitelists[f.venue.row.chainId]}
                  settings={settings}
                  issues={issues[`${f.chainId}:${f.id.toLowerCase()}`] ?? NO_ISSUES}
                />
              ),
            )}
            {manualEntries.map(({ chainId, id }) => (
              <tr key={`${chainId}:${id}`} className="on" onClick={() => whitelists[chainId].toggle(id)}>
                <td>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => whitelists[chainId].toggle(id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Remove market ${id} from the whitelist`}
                  />
                </td>
                <td colSpan={8}>
                  <span className="badge">{CHAINS[chainId].shortName}</span> <span className="mono tiny">{id}</span>{" "}
                  <span className="badge">by id</span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="muted">
                  No market matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="row gap wrap">
        <select value={manualChain} onChange={(e) => setManualChain(Number(e.target.value) as SupportedChainId)}>
          {(Object.keys(whitelists) as unknown as SupportedChainId[]).map((id) => (
            <option key={id} value={id}>
              {CHAINS[id].name}
            </option>
          ))}
        </select>
        <input
          className="mono grow"
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
        Listed USDC, USDT and aUSD markets from the Morpho API. Each row is a collateral backing a deposit token, and
        pools are per deposit token. Cap is the max share of that market's own pool; Locked is capital tied up in a loop
        that is never withdrawn. Rates and positions are read on-chain.
      </p>
    </section>
  );
}

interface VaultRowProps {
  chainId: SupportedChainId;
  vault: ApiVault;
  whitelist: ReturnType<typeof useWhitelist>;
  settings: ReturnType<typeof useMarketSettings>;
  issues: string[];
}

/**
 * A vault row. The APY column shows yield after the vault's fee, so it is directly comparable with a
 * market's supply APY, and Total adds incentives on top — the figure a depositor actually earns.
 */
function VaultRow({ chainId, vault, whitelist, settings, issues }: VaultRowProps) {
  const id = vault.address;
  const on = whitelist.set.has(id.toLowerCase());
  const baseApy = vault.state?.apy ?? 0;
  const fee = vault.state?.fee ?? 0;
  const rewards = vaultRewardApr(vault);
  const afterFee = baseApy * (1 - fee);
  const net = vaultNetApy({ baseApy, fee, rewardApr: rewards });
  const setting = settings.get(chainId, id);
  const [lockedText, setLockedText] = useState<string | undefined>(undefined);

  const lockedValue =
    lockedText ?? (setting?.lockedUnits && setting.lockedUnits !== "0" ? formatUnits6(setting.lockedUnits) : "");

  const commitLocked = (text: string) => {
    const units = parseUnits6(text);
    if (units === undefined) return;
    settings.setMarket(chainId, id, { lockedUnits: units === 0n ? undefined : units.toString() });
  };

  return (
    <tr className={on ? "on vault" : "vault"}>
      <td onClick={() => whitelist.toggle(id)}>
        <input
          type="checkbox"
          checked={on}
          onChange={() => whitelist.toggle(id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Whitelist vault ${vault.name}`}
        />
      </td>
      <td onClick={() => whitelist.toggle(id)}>
        <div className="market-name">
          <span className="collateral" title={vault.name}>
            {vault.name}
          </span>
          <AlertIcon issues={issues} />
          <span className="badge vault-badge">VAULT</span>
          <span className="badge">{CHAINS[chainId].shortName}</span>
        </div>
        <div className="tiny muted" title={id}>
          deposit <span className="deposit">{vault.asset.symbol}</span> · <span className="mono">{shortAddr(id)}</span>
        </div>
      </td>
      <td className="num muted">—</td>
      <td className="num">{fmtUsdCompact(vault.state?.totalAssetsUsd ?? 0)}</td>
      <td className="num muted">—</td>
      <td className="num">
        <div>{fmtApy(afterFee)}</div>
        {fee > 0 && <div className="tiny muted">−{fmtPct(fee, 0)} fee</div>}
      </td>
      <td className="num strong">
        <div>{fmtApy(net)}</div>
        {rewards > 0 && <div className="tiny muted">+{fmtApy(rewards)} rw</div>}
      </td>
      <td className="num">
        <input
          className="mini"
          type="number"
          min={1}
          max={100}
          placeholder={String(settings.settings.defaultCapPct)}
          value={setting?.capPct ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            settings.setMarket(chainId, id, { capPct: v === "" ? undefined : Number(v) });
          }}
          title="Max share of this pool for this vault. Blank uses the default."
        />
      </td>
      <td className="num">
        <input
          className="mini wide"
          inputMode="decimal"
          placeholder="0"
          value={lockedValue}
          onChange={(e) => {
            setLockedText(e.target.value);
            commitLocked(e.target.value);
          }}
          onBlur={() => setLockedText(undefined)}
          title="Amount locked here. Never withdrawn by the optimizer."
        />
      </td>
    </tr>
  );
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  sort: MarketSort;
  onSortChange: (s: MarketSort) => void;
  num?: boolean;
  title?: string;
}

function SortHeader({ label, sortKey, sort, onSortChange, num, title }: SortHeaderProps) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`${num ? "num " : ""}sortable${active ? " sorted" : ""}`}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => onSortChange(nextSort(sort, sortKey))} title={title ?? `Sort by ${label}`}>
        {label}
        <span className="sort-arrow" aria-hidden="true">
          {active ? (sort.direction === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

interface RowProps {
  chainId: SupportedChainId;
  market: ApiMarket;
  whitelist: ReturnType<typeof useWhitelist>;
  settings: ReturnType<typeof useMarketSettings>;
  issues: string[];
}

function MarketRow({ chainId, market, whitelist, settings, issues }: RowProps) {
  const id = market.marketId;
  const on = whitelist.set.has(id.toLowerCase());
  const rw = rewardApr(market);
  const setting = settings.get(chainId, id);
  const [lockedText, setLockedText] = useState<string | undefined>(undefined);
  // Every managed loan asset is 6-decimal; the API sends raw token units.
  const liquidityText = describeLiquidity(
    Number(market.state?.liquidityAssets ?? 0) / 1e6,
    Number(market.state?.supplyAssets ?? 0) / 1e6,
    market.loanAsset.symbol,
  );
  const allIssues = mergeLiquidityIssue(liquidityText, issues);

  // The locked field is free text while being typed, and only committed when it parses.
  const lockedValue =
    lockedText ?? (setting?.lockedUnits && setting.lockedUnits !== "0" ? formatUnits6(setting.lockedUnits) : "");

  const commitLocked = (text: string) => {
    const units = parseUnits6(text);
    if (units === undefined) return;
    settings.setMarket(chainId, id, { lockedUnits: units === 0n ? undefined : units.toString() });
  };

  return (
    <tr className={on ? "on" : ""}>
      <td onClick={() => whitelist.toggle(id)}>
        {/* The whole row toggles, but the checkbox stays a real control so the list is
            keyboard-reachable; it stops the click so the row handler does not undo it. */}
        <input
          type="checkbox"
          checked={on}
          onChange={() => whitelist.toggle(id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Whitelist ${market.collateralAsset?.symbol ?? "market"} / ${market.loanAsset.symbol}`}
        />
      </td>
      <td onClick={() => whitelist.toggle(id)}>
        {/* Collateral and deposit token are named separately: the collateral is what backs the
            loan, the deposit token is what you actually supply and what defines the pool. */}
        <div className="market-name">
          <span className="collateral">{market.collateralAsset?.symbol ?? "?"}</span>
          <AlertIcon issues={allIssues} />
          <span className="badge">{CHAINS[chainId].shortName}</span>
        </div>
        <div className="tiny muted" title={id}>
          deposit <span className="deposit">{market.loanAsset.symbol}</span> ·{" "}
          <span className="mono">{shortAddr(id)}</span>
        </div>
      </td>
      <td className="num">{fmtPct(Number(market.lltv) / 1e18, 0)}</td>
      <td className="num">{fmtUsdCompact(market.state?.supplyAssetsUsd ?? 0)}</td>
      <td className="num">{fmtPct(market.state?.utilization ?? 0, 0)}</td>
      <td className="num">
        <div>{fmtApy(market.state?.supplyApy ?? 0)}</div>
        {rw > 0 && <div className="tiny muted">+{fmtApy(rw)} rw</div>}
      </td>
      {/* A drained market's APY is a utilization spike, not a rate you can earn; mute it to amber so it
          does not read as the best market in the list. The reason is on the sign by the name. */}
      <td className={`num strong${liquidityText ? " warn" : ""}`}>{fmtApy((market.state?.supplyApy ?? 0) + rw)}</td>
      <td className="num">
        <input
          className="mini"
          type="number"
          min={1}
          max={100}
          placeholder={String(settings.settings.defaultCapPct)}
          value={setting?.capPct ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            settings.setMarket(chainId, id, { capPct: v === "" ? undefined : Number(v) });
          }}
          title="Max share of this pool for this market. Blank uses the default."
        />
      </td>
      <td className="num">
        <input
          className="mini wide"
          inputMode="decimal"
          placeholder="0"
          value={lockedValue}
          onChange={(e) => {
            setLockedText(e.target.value);
            commitLocked(e.target.value);
          }}
          onBlur={() => setLockedText(undefined)}
          title="Amount locked in a loop here. Never withdrawn by the optimizer."
        />
      </td>
    </tr>
  );
}

function formatUnits6(units: string): string {
  try {
    const n = BigInt(units);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "";
  }
}
