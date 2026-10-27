import type { Address } from "viem";
import { arbitrum, base, hyperEvm, mainnet, monad } from "viem/chains";

export type SupportedChainId =
  | typeof mainnet.id
  | typeof base.id
  | typeof arbitrum.id
  | typeof hyperEvm.id
  | typeof monad.id;

/** A loan asset the allocator can manage. Each (chain, loan asset) pair is an independent pool. */
export interface LoanAsset {
  /**
   * Symbol exactly as the Morpho API reports it, so the loan-asset filter and the pool labels agree.
   * Note "AUSD" (Agora) and "USDT0" (Tether's omnichain USDT, the canonical USDT on Arbitrum).
   */
  symbol: string;
  address: Address;
  decimals: number;
}

export interface ChainConfig {
  id: SupportedChainId;
  name: string;
  shortName: string;
  /** Morpho Blue is NOT at the same address on every chain — never assume it. */
  morpho: Address;
  bundler3: Address;
  generalAdapter1: Address;
  adaptiveCurveIrm: Address;
  /**
   * Loan assets managed on this chain. A Bundler3 bundle can only move value between markets that
   * share a loan asset, so each entry here is a separate portfolio with its own rebalance.
   */
  loanAssets: LoanAsset[];
  /** The .env key that overrides the public RPCs, e.g. VITE_RPC_MAINNET. */
  rpcEnvKey: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
  /** Dedicated endpoint from .env, used first when set. */
  rpcUrl?: string;
  /** Public endpoints verified against this app's batched-multicall read pattern (probe-chains.mjs). */
  publicRpcs: string[];
}

const AUSD: Address = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";

function explorers(base: string) {
  return {
    explorerTx: (h: string) => `${base}/tx/${h}`,
    explorerAddress: (a: string) => `${base}/address/${a}`,
  };
}

export const CHAINS: Record<SupportedChainId, ChainConfig> = {
  [mainnet.id]: {
    id: mainnet.id,
    name: "Ethereum",
    shortName: "ETH",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
    generalAdapter1: "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0",
    adaptiveCurveIrm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    loanAssets: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      { symbol: "AUSD", address: AUSD, decimals: 6 },
    ],
    rpcEnvKey: "VITE_RPC_MAINNET",
    ...explorers("https://etherscan.io"),
    rpcUrl: import.meta.env.VITE_RPC_MAINNET || undefined,
    publicRpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  },
  [base.id]: {
    id: base.id,
    name: "Base",
    shortName: "BASE",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
    generalAdapter1: "0xb98c948CFA24072e58935BC004a8A7b376AE746A",
    adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    loanAssets: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
    rpcEnvKey: "VITE_RPC_BASE",
    ...explorers("https://basescan.org"),
    rpcUrl: import.meta.env.VITE_RPC_BASE || undefined,
    // mainnet.base.org rate-limits aggressively under this app's read pattern, so it goes last.
    publicRpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  },
  [arbitrum.id]: {
    id: arbitrum.id,
    name: "Arbitrum",
    shortName: "ARB",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    bundler3: "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13",
    generalAdapter1: "0x9954aFB60BB5A222714c478ac86990F221788B88",
    adaptiveCurveIrm: "0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA",
    loanAssets: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      // USDT0 is Tether's omnichain USDT and the asset Morpho lists on Arbitrum; plain USDT has no
      // listed markets here.
      { symbol: "USDT0", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    ],
    rpcEnvKey: "VITE_RPC_ARBITRUM",
    ...explorers("https://arbiscan.io"),
    rpcUrl: import.meta.env.VITE_RPC_ARBITRUM || undefined,
    publicRpcs: [
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.drpc.org",
      "https://arb1.arbitrum.io/rpc",
    ],
  },
  [hyperEvm.id]: {
    id: hyperEvm.id,
    name: "HyperEVM",
    shortName: "HYPE",
    morpho: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
    bundler3: "0xa3F50477AfA601C771874260A3B34B40e244Fa0e",
    generalAdapter1: "0xD7F48aDE56613E8605863832B7B8A1985B934aE4",
    adaptiveCurveIrm: "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483",
    loanAssets: [{ symbol: "USDC", address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", decimals: 6 }],
    rpcEnvKey: "VITE_RPC_HYPEREVM",
    ...explorers("https://hyperevmscan.io"),
    rpcUrl: import.meta.env.VITE_RPC_HYPEREVM || undefined,
    publicRpcs: ["https://rpc.hyperliquid.xyz/evm", "https://hyperliquid.drpc.org", "https://rpc.hypurrscan.io"],
  },
  [monad.id]: {
    id: monad.id,
    name: "Monad",
    shortName: "MON",
    morpho: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
    bundler3: "0x82b684483e844422FD339df0b67b3B111F02c66E",
    generalAdapter1: "0x725AB8CAd931BCb80Fdbf10955a806765cCe00e5",
    adaptiveCurveIrm: "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
    loanAssets: [
      { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
      { symbol: "AUSD", address: AUSD, decimals: 6 },
    ],
    rpcEnvKey: "VITE_RPC_MONAD",
    ...explorers("https://monadscan.com"),
    rpcUrl: import.meta.env.VITE_RPC_MONAD || undefined,
    publicRpcs: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"],
  },
};

/**
 * Fixed, module-level and ordered. Hooks fan out over this array, so it must never change at runtime.
 */
export const SUPPORTED_CHAIN_IDS = [mainnet.id, base.id, arbitrum.id, hyperEvm.id, monad.id] as const;

/** Every supported loan asset is 6-decimal, which keeps formatting and the optimizer's units uniform. */
export const USDC_DECIMALS = 6;

export function isSupportedChain(id: number | undefined): id is SupportedChainId {
  return id !== undefined && id in CHAINS;
}

export function getChainConfig(id: SupportedChainId): ChainConfig {
  return CHAINS[id];
}

/** Stable identifier for a (chain, loan asset) pool. */
export function poolId(chainId: number, asset: Address): string {
  return `${chainId}:${asset.toLowerCase()}`;
}

export function findLoanAsset(chainId: SupportedChainId, asset: Address): LoanAsset | undefined {
  const lower = asset.toLowerCase();
  return CHAINS[chainId]?.loanAssets.find((a) => a.address.toLowerCase() === lower);
}

export interface Pool {
  chain: ChainConfig;
  asset: LoanAsset;
}

/** Every (chain, loan asset) pool across all supported chains. */
export function allPools(): Pool[] {
  return SUPPORTED_CHAIN_IDS.flatMap((id) => CHAINS[id].loanAssets.map((asset) => ({ chain: CHAINS[id], asset })));
}

/** Distinct loan-asset symbols across all chains, for the loan-asset filter. */
export function allLoanAssetSymbols(): string[] {
  return Array.from(new Set(allPools().map((p) => p.asset.symbol)));
}
