// Builds a Bundler3 multicall that rebalances a pool atomically across both venue kinds, Morpho Blue
// markets and ERC-4626 vaults:
//   1. withdraw from over-allocated markets, and redeem from over-allocated vaults, into GeneralAdapter1
//   2. supply/deposit from the adapter into under-allocated venues (last leg sweeps the whole balance)
//   3. skim any leftover loan token back to the user
//
// Prerequisites: Morpho.setAuthorization(GeneralAdapter1, true) for the market legs, and — only when a
// vault is being exited — an ERC-20 approval of that vault's share token to the adapter, since
// redeeming pulls the user's shares. Depositing into a vault spends the adapter's own balance and
// needs no approval, so a bundle that only moves *into* vaults stays approval-free.
//
// When the user opts to deploy idle wallet capital, the bundle starts by pulling exactly that amount
// of loan token from the wallet (step 0), which needs a loan-token allowance of that size.

import { encodeFunctionData, type Address, type Hex } from "viem";
import { bundler3Abi } from "../abi/bundler3";
import { generalAdapter1Abi } from "../abi/generalAdapter1";
import type { ChainConfig } from "../config/chains";
import { MAX_UINT256, sharePriceE27 } from "./math";
import type { MarketParams } from "./types";
import { vaultConvertToShares, vaultSharePriceE27 } from "./vault";

/** A vault leg carries the vault address and its share accounting instead of market params. */
export interface VaultLeg {
  kind: "vault";
  /** The vault (ERC-4626) address. */
  id: Address;
  current: bigint;
  target: bigint;
  delta: bigint;
  /** The user's share balance, needed to redeem the whole position exactly. */
  shares: bigint;
  totalAssets: bigint;
  totalShares: bigint;
  /** The vault's underlying asset; must equal the pool's loan token. */
  asset: Address;
}

export interface MarketLeg {
  kind?: "market";
  id: Hex;
  params: MarketParams;
  current: bigint;
  target: bigint;
  delta: bigint;
  /** Accrued totals, used to derive the expected share price for the bounds. */
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
}

export type RebalanceLeg = MarketLeg | VaultLeg;

export function isVaultLeg(l: RebalanceLeg): l is VaultLeg {
  return (l as VaultLeg).kind === "vault";
}

export interface BuildBundleInput {
  legs: RebalanceLeg[];
  user: Address;
  chain: Pick<ChainConfig, "generalAdapter1">;
  /**
   * The pool's loan token. A bundle only ever moves one loan asset: value cannot cross assets
   * without a swap, so every leg must share this token.
   */
  loanToken: Address;
  /** Share-price slippage tolerance in basis points (default 10 = 0.1%). */
  slippageBps?: number;
  /**
   * Idle wallet capital available to this bundle. Only what the supply legs need beyond the
   * withdrawals is actually pulled, so this is an upper bound, not an instruction.
   */
  walletAvailable?: bigint;
  /** When true (default) the last supply leg uses type(uint256).max to absorb rounding dust. */
  sweepIntoLastSupply?: boolean;
}

export interface BundleCall {
  to: Address;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
}

export interface BundleStep {
  kind: "wallet-pull" | "withdraw" | "supply" | "skim" | "vault-redeem" | "vault-deposit";
  marketId?: Hex;
  /** For vault steps: the vault address. */
  vault?: Address;
  amount: bigint | "max";
  fullExit?: boolean;
}

export interface RebalanceBundle {
  calls: BundleCall[];
  steps: BundleStep[];
  totalWithdraw: bigint;
  totalSupply: bigint;
  /**
   * Vault share tokens the user must approve to the adapter before this bundle can run. Empty unless
   * the bundle exits a vault: deposits spend the adapter's own balance and need nothing.
   */
  requiresApproval: { vault: Address; shares: bigint }[];
  /** Loan token pulled from the wallet in step 0. Needs an allowance of exactly this much. */
  walletPull: bigint;
}

/** Shares a partial withdrawal will consume, rounded up so the allowance is never short. */
function vaultSharesFor(assets: bigint, leg: VaultLeg): bigint {
  return vaultConvertToShares(assets, leg.totalAssets, leg.totalShares);
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
const BPS = 10_000n;

export function buildRebalanceBundle(input: BuildBundleInput): RebalanceBundle {
  const slippageBps = BigInt(input.slippageBps ?? 10);
  const sweep = input.sweepIntoLastSupply ?? true;
  const adapter = input.chain.generalAdapter1;

  // A bundle moves value between markets by withdrawing into the adapter and supplying back out, so
  // mixing loan assets would silently supply the wrong token. Refuse rather than build it.
  const assetOf = (l: RebalanceLeg) => (isVaultLeg(l) ? l.asset : l.params.loanToken);
  const foreign = input.legs.find((l) => assetOf(l).toLowerCase() !== input.loanToken.toLowerCase());
  if (foreign) {
    throw new Error(
      `${isVaultLeg(foreign) ? "Vault" : "Market"} ${foreign.id.slice(0, 10)}… holds ${assetOf(foreign)}, not ` +
        `${input.loanToken}; a bundle cannot move value across loan assets.`,
    );
  }

  const withdraws = input.legs.filter((l) => l.delta < 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));
  const supplies = input.legs.filter((l) => l.delta > 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));

  const totalWithdraw = withdraws.reduce((acc, l) => acc + (l.target === 0n ? l.current : -l.delta), 0n);
  const totalSupply = supplies.reduce((acc, l) => acc + l.delta, 0n);

  // Whatever the supplies need beyond what the withdrawals free up must come from the wallet.
  const walletAvailable = input.walletAvailable ?? 0n;
  const walletPull = totalSupply > totalWithdraw ? totalSupply - totalWithdraw : 0n;
  if (walletPull > walletAvailable) {
    throw new Error(
      walletAvailable === 0n
        ? `Bundle would supply ${totalSupply} but only withdraw ${totalWithdraw}; wallet balances are not part of the portfolio.`
        : `Bundle needs ${walletPull} from the wallet but only ${walletAvailable} is available.`,
    );
  }

  const calls: BundleCall[] = [];
  const steps: BundleStep[] = [];

  if (walletPull > 0n) {
    // Exactly the shortfall, never the whole balance or type(uint256).max: the allowance granted for
    // this bundle is the same figure, so nothing beyond it can ever be pulled.
    calls.push(
      call(
        adapter,
        encodeFunctionData({
          abi: generalAdapter1Abi,
          functionName: "erc20TransferFrom",
          args: [input.loanToken, adapter, walletPull],
        }),
      ),
    );
    steps.push({ kind: "wallet-pull", amount: walletPull });
  }

  for (const leg of withdraws) {
    const fullExit = leg.target === 0n;
    if (isVaultLeg(leg)) {
      // Redeeming pulls the user's shares, so this leg only works once the vault's share token is
      // approved to the adapter. A full exit redeems the whole share balance so no dust is left.
      const minSharePrice = (vaultSharePriceE27(leg.totalAssets, leg.totalShares) * (BPS - slippageBps)) / BPS;
      // Both exit paths take (…, minSharePriceE27, receiver, owner) and assert
      // assets/shares >= minSharePriceE27 — getting fewer assets per share is the bad case. The
      // receiver is the adapter, because the bundle spends the proceeds in later legs; the owner is
      // the user, whose shares are being pulled.
      const data = fullExit
        ? encodeFunctionData({
            abi: generalAdapter1Abi,
            functionName: "erc4626Redeem",
            args: [leg.id, leg.shares, minSharePrice, adapter, input.user],
          })
        : encodeFunctionData({
            abi: generalAdapter1Abi,
            functionName: "erc4626Withdraw",
            args: [leg.id, -leg.delta, minSharePrice, adapter, input.user],
          });
      calls.push(call(adapter, data));
      steps.push({ kind: "vault-redeem", vault: leg.id, amount: fullExit ? "max" : -leg.delta, fullExit });
      continue;
    }
    const minSharePrice = (sharePriceE27(leg.totalSupplyAssets, leg.totalSupplyShares) * (BPS - slippageBps)) / BPS;
    const data = encodeFunctionData({
      abi: generalAdapter1Abi,
      functionName: "morphoWithdraw",
      args: [leg.params, fullExit ? 0n : -leg.delta, fullExit ? MAX_UINT256 : 0n, minSharePrice, adapter],
    });
    calls.push(call(adapter, data));
    steps.push({ kind: "withdraw", marketId: leg.id, amount: fullExit ? "max" : -leg.delta, fullExit });
  }

  supplies.forEach((leg, i) => {
    const isLast = i === supplies.length - 1;
    const useMax = sweep && isLast;
    if (isVaultLeg(leg)) {
      // Deposits spend the adapter's own balance, so no approval is involved on this side.
      const maxSharePrice = (vaultSharePriceE27(leg.totalAssets, leg.totalShares) * (BPS + slippageBps)) / BPS;
      const data = encodeFunctionData({
        abi: generalAdapter1Abi,
        functionName: "erc4626Deposit",
        args: [leg.id, useMax ? MAX_UINT256 : leg.delta, maxSharePrice, input.user],
      });
      calls.push(call(adapter, data));
      steps.push({ kind: "vault-deposit", vault: leg.id, amount: useMax ? "max" : leg.delta });
      return;
    }
    const maxSharePrice = (sharePriceE27(leg.totalSupplyAssets, leg.totalSupplyShares) * (BPS + slippageBps)) / BPS;
    const data = encodeFunctionData({
      abi: generalAdapter1Abi,
      functionName: "morphoSupply",
      args: [leg.params, useMax ? MAX_UINT256 : leg.delta, 0n, maxSharePrice, input.user, "0x"],
    });
    calls.push(call(adapter, data));
    steps.push({ kind: "supply", marketId: leg.id, amount: useMax ? "max" : leg.delta });
  });

  // Safety skim: return any loan token left in the adapter to the user. No-op when the balance is zero.
  const skimData = encodeFunctionData({
    abi: generalAdapter1Abi,
    functionName: "erc20Transfer",
    args: [input.loanToken, input.user, MAX_UINT256],
  });
  calls.push({ ...call(adapter, skimData), skipRevert: true });
  steps.push({ kind: "skim", amount: "max" });

  // Only vault exits pull the user's tokens, so only they can require an allowance.
  const requiresApproval = withdraws
    .filter(isVaultLeg)
    .map((l) => ({ vault: l.id, shares: l.target === 0n ? l.shares : vaultSharesFor(-l.delta, l) }));

  return { calls, steps, totalWithdraw, totalSupply, requiresApproval, walletPull };
}

export function encodeBundlerMulticall(calls: BundleCall[]): Hex {
  return encodeFunctionData({ abi: bundler3Abi, functionName: "multicall", args: [calls] });
}

function call(to: Address, data: Hex): BundleCall {
  return { to, data, value: 0n, skipRevert: false, callbackHash: ZERO_HASH };
}
