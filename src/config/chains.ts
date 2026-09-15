import type { Address } from "viem";
import { base, mainnet } from "viem/chains";

export type SupportedChainId = typeof mainnet.id | typeof base.id;

export interface ChainConfig {
  id: SupportedChainId;
  name: string;
  shortName: string;
  morpho: Address;
  bundler3: Address;
  generalAdapter1: Address;
  adaptiveCurveIrm: Address;
  usdc: Address;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
  /** Dedicated endpoint from .env, used first when set. */
  rpcUrl?: string;
  /** Public endpoints verified to serve the batched multicalls this app makes. */
  publicRpcs: string[];
}

// Morpho Blue is deployed at the same address on every chain.
const MORPHO: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

export const CHAINS: Record<SupportedChainId, ChainConfig> = {
  [mainnet.id]: {
    id: mainnet.id,
    name: "Ethereum",
    shortName: "ETH",
    morpho: MORPHO,
    bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
    generalAdapter1: "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0",
    adaptiveCurveIrm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    explorerTx: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddress: (a) => `https://etherscan.io/address/${a}`,
    rpcUrl: import.meta.env.VITE_RPC_MAINNET || undefined,
    publicRpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  },
  [base.id]: {
    id: base.id,
    name: "Base",
    shortName: "BASE",
    morpho: MORPHO,
    bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
    generalAdapter1: "0xb98c948CFA24072e58935BC004a8A7b376AE746A",
    adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://basescan.org/address/${a}`,
    rpcUrl: import.meta.env.VITE_RPC_BASE || undefined,
    // mainnet.base.org rate-limits aggressively under this app's read pattern, so it goes last.
    publicRpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  },
};

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number) as SupportedChainId[];

export const USDC_DECIMALS = 6;

export function isSupportedChain(id: number | undefined): id is SupportedChainId {
  return id !== undefined && id in CHAINS;
}

export function getChainConfig(id: SupportedChainId): ChainConfig {
  return CHAINS[id];
}
