import { fallback, http, createConfig } from "wagmi";
import { base, mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { CHAINS, type SupportedChainId } from "./chains";

/** Dedicated endpoint first (when configured), then verified public ones as backups. */
function transportFor(chainId: SupportedChainId) {
  const cfg = CHAINS[chainId];
  const urls = [...(cfg.rpcUrl ? [cfg.rpcUrl] : []), ...cfg.publicRpcs];
  return fallback(
    urls.map((url) => http(url, { batch: true, retryCount: 2, retryDelay: 500 })),
    { rank: false },
  );
}

// EIP-6963 discovery is on by default: the Fordefi extension announces itself and shows up as its own
// connector. The generic `injected()` connector is kept as a fallback (e.g. Fordefi's MetaMask emulation).
export const wagmiConfig = createConfig({
  chains: [mainnet, base],
  multiInjectedProviderDiscovery: true,
  connectors: [injected()],
  transports: {
    [mainnet.id]: transportFor(mainnet.id),
    [base.id]: transportFor(base.id),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
