import { CHAINS, SUPPORTED_CHAIN_IDS, type SupportedChainId } from "../config/chains";

interface Props {
  value: SupportedChainId;
  onChange: (id: SupportedChainId) => void;
}

export function ChainSelector({ value, onChange }: Props) {
  return (
    <div className="segmented" role="tablist" aria-label="Chain">
      {SUPPORTED_CHAIN_IDS.map((id) => (
        <button
          key={id}
          role="tab"
          aria-selected={id === value}
          className={id === value ? "active" : ""}
          onClick={() => onChange(id)}
        >
          {CHAINS[id].name}
        </button>
      ))}
    </div>
  );
}
