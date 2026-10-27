import { parseAbi, type Address, type PublicClient } from "viem";
import type { ChainConfig } from "../config/chains";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** Idle balance of one loan token, and how much of it GeneralAdapter1 may already pull. */
export interface WalletToken {
  balance: bigint;
  allowance: bigint;
}

/**
 * The user's idle balance of every loan asset managed on a chain, with its allowance to the adapter.
 * Keyed by lowercased token address. A token that fails to read is left out rather than shown as 0.
 */
export async function fetchWalletTokens(
  client: PublicClient,
  chain: ChainConfig,
  user: Address,
): Promise<Record<string, WalletToken>> {
  const tokens = chain.loanAssets.map((a) => a.address);
  const reads = await client.multicall({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "balanceOf", args: [user] } as const,
      { address: t, abi: erc20Abi, functionName: "allowance", args: [user, chain.generalAdapter1] } as const,
    ]),
  });
  const out: Record<string, WalletToken> = {};
  tokens.forEach((t, i) => {
    const [bal, allow] = [reads[i * 2], reads[i * 2 + 1]];
    if (bal.status !== "success") return;
    out[t.toLowerCase()] = {
      balance: bal.result as bigint,
      allowance: allow.status === "success" ? (allow.result as bigint) : 0n,
    };
  });
  return out;
}
