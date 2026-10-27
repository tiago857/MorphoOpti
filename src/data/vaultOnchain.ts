import { parseAbi, type Address, type PublicClient } from "viem";
import type { ChainConfig } from "../config/chains";
import { vaultConvertToAssets, vaultNetApy } from "../core/vault";
import { vaultRewardApr, type ApiVault } from "./morphoApi";

export const erc4626Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
]);

/** A vault position as the optimizer and the bundle need it, read on-chain and priced off the API. */
export interface PortfolioVault {
  kind: "vault";
  id: Address;
  name: string;
  asset: Address;
  assetSymbol: string;
  /** The user's share balance. */
  shares: bigint;
  /** What those shares are worth right now, in token units. */
  supplyAssets: bigint;
  totalAssets: bigint;
  totalShares: bigint;
  /** Gross APY before the vault's fee. */
  baseApy: number;
  fee: number;
  rewardApr: number;
  /** Yield net of the vault fee, before incentives — the flat rate the optimizer uses. */
  apyAfterFee: number;
  /** What a depositor actually earns: yield net of fee, plus incentives. */
  netApy: number;
  totalAssetsUsd: number;
  /** Allowance the user has granted the adapter on this vault's share token. */
  allowance: bigint;
  /**
   * What this vault can actually pay out to the user right now. A vault is only as liquid as the
   * free liquidity of the markets it allocates into, so a large position can exceed it — exiting
   * beyond this reverts with the vault's own NotEnoughLiquidity.
   */
  maxWithdraw: bigint;
  whitelisted: boolean;
}

export interface FetchVaultsArgs {
  client: PublicClient;
  chain: ChainConfig;
  user: Address;
  vaults: ApiVault[];
  whitelist: Set<string>;
}

/**
 * Read live share balances, vault size and adapter allowance for each vault. Rates come from the API
 * (a vault has no on-chain rate to read — it is the aggregate of its underlying markets).
 */
export async function fetchVaultPositions({
  client,
  chain,
  user,
  vaults,
  whitelist,
}: FetchVaultsArgs): Promise<PortfolioVault[]> {
  if (vaults.length === 0) return [];

  const reads = await client.multicall({
    allowFailure: true,
    contracts: vaults.flatMap((v) => [
      { address: v.address, abi: erc4626Abi, functionName: "balanceOf", args: [user] } as const,
      { address: v.address, abi: erc4626Abi, functionName: "totalAssets" } as const,
      { address: v.address, abi: erc4626Abi, functionName: "totalSupply" } as const,
      {
        address: v.address,
        abi: erc4626Abi,
        functionName: "allowance",
        args: [user, chain.generalAdapter1],
      } as const,
      { address: v.address, abi: erc4626Abi, functionName: "maxWithdraw", args: [user] } as const,
    ]),
  });

  const out: PortfolioVault[] = [];
  vaults.forEach((v, i) => {
    const [bal, ta, ts, allow, maxW] = reads.slice(i * 5, i * 5 + 5);
    // A vault that fails to read is skipped rather than shown with invented numbers.
    if (bal.status !== "success" || ta.status !== "success" || ts.status !== "success") return;

    const shares = bal.result as bigint;
    const totalAssets = ta.result as bigint;
    const totalShares = ts.result as bigint;
    const baseApy = v.state?.apy ?? 0;
    const fee = v.state?.fee ?? 0;
    const rewardApr = vaultRewardApr(v);

    out.push({
      kind: "vault",
      id: v.address,
      name: v.name,
      asset: v.asset.address,
      assetSymbol: v.asset.symbol,
      shares,
      supplyAssets: vaultConvertToAssets(shares, totalAssets, totalShares),
      totalAssets,
      totalShares,
      baseApy,
      fee,
      rewardApr,
      apyAfterFee: baseApy * (1 - fee),
      netApy: vaultNetApy({ baseApy, fee, rewardApr }),
      totalAssetsUsd: v.state?.totalAssetsUsd ?? 0,
      allowance: allow.status === "success" ? (allow.result as bigint) : 0n,
      // If the vault will not answer maxWithdraw, assume the position is illiquid rather than
      // planning an exit that would revert.
      maxWithdraw: maxW.status === "success" ? (maxW.result as bigint) : 0n,
      whitelisted: whitelist.has(v.address.toLowerCase()),
    });
  });
  return out;
}

/** Minimal ERC-20 approve, used to let the adapter pull vault shares on an exit. */
export const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
