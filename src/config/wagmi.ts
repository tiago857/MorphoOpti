import { createConfig, fallback, http } from "wagmi";
import { arbitrum, base, hyperEvm, mainnet, monad } from "wagmi/chains";
import { CHAINS, type SupportedChainId } from "./chains";
import { injected } from "wagmi/connectors";

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
  chains: [mainnet, base, arbitrum, hyperEvm, monad],
  multiInjectedProviderDiscovery: true,
  connectors: [injected()],
  transports: {
    [mainnet.id]: transportFor(mainnet.id),
    [base.id]: transportFor(base.id),
    [arbitrum.id]: transportFor(arbitrum.id),
    [hyperEvm.id]: transportFor(hyperEvm.id),
    [monad.id]: transportFor(monad.id),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
