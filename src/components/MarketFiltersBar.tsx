import { CHAINS, type SupportedChainId } from "../config/chains";
import { DEFAULT_FILTERS, isDefaultFilters, toggleValue, type FilterOptions, type MarketFilters } from "../core/filters";
import { fmtUsdCompact } from "../lib/format";

interface Props {
  filters: MarketFilters;
  options: FilterOptions;
  onChange: (next: MarketFilters) => void;
  matched: number;
  total: number;
}

const SIZE_STEPS = [0, 100e3, 1e6, 10e6, 100e6];

/** Multi-select chip group. An empty selection means "all", which is how every filter starts. */
function ChipGroup<T extends string | number>({
  label,
  values,
  selected,
  render,
  onToggle,
}: {
  label: string;
  values: T[];
  selected: T[];
  render: (v: T) => string;
  onToggle: (v: T) => void;
}) {
  if (values.length <= 1) return null;
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      <div className="chips">
        {values.map((v) => (
          <button
            key={String(v)}
            type="button"
            className={`chip ${selected.includes(v) ? "on" : ""}`}
            aria-pressed={selected.includes(v)}
            onClick={() => onToggle(v)}
          >
            {render(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MarketFiltersBar({ filters, options, onChange, matched, total }: Props) {
  const set = (patch: Partial<MarketFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="filters">
      <div className="row gap wrap">
        <input
          className="grow"
          placeholder="Search collateral, loan asset or market id…"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
        />
        <span className="muted tiny">
          {matched} of {total} markets
        </span>
        {!isDefaultFilters(filters) && (
          <button className="ghost" onClick={() => onChange(DEFAULT_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>

      <div className="filter-rows">
        <ChipGroup
          label="Chain"
          values={options.chainIds}
          selected={filters.chainIds}
          render={(id) => CHAINS[id as SupportedChainId]?.name ?? String(id)}
          onToggle={(id) => set({ chainIds: toggleValue(filters.chainIds, id) })}
        />
        <ChipGroup
          label="Loan asset"
          values={options.loanSymbols}
          selected={filters.loanSymbols}
          render={(s) => s}
          onToggle={(s) => set({ loanSymbols: toggleValue(filters.loanSymbols, s) })}
        />
        <div className="filter-group">
          <span className="filter-label">Min size</span>
          <div className="chips">
            {SIZE_STEPS.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip ${filters.minSupplyUsd === v ? "on" : ""}`}
                aria-pressed={filters.minSupplyUsd === v}
                onClick={() => set({ minSupplyUsd: v })}
              >
                {v === 0 ? "Any" : fmtUsdCompact(v)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-label">Min liquidity</span>
          <div className="chips">
            {SIZE_STEPS.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip ${filters.minLiquidityUsd === v ? "on" : ""}`}
                aria-pressed={filters.minLiquidityUsd === v}
                onClick={() => set({ minLiquidityUsd: v })}
              >
                {v === 0 ? "Any" : fmtUsdCompact(v)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

