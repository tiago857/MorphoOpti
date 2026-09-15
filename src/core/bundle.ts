// Builds a Bundler3 multicall that rebalances Morpho Blue supply positions atomically:
//   1. withdraw from over-allocated markets into GeneralAdapter1
//   2. supply from the adapter into under-allocated markets (last leg sweeps the whole adapter balance)
//   3. skim any leftover USDC back to the user
//
// Prerequisite: Morpho.setAuthorization(GeneralAdapter1, true) by the user. No ERC-20 approvals needed
// because no funds are pulled from the wallet.

import { encodeFunctionData, type Address, type Hex } from "viem";
import { bundler3Abi } from "../abi/bundler3";
import { generalAdapter1Abi } from "../abi/generalAdapter1";
import type { ChainConfig } from "../config/chains";
import { MAX_UINT256, sharePriceE27 } from "./math";
import type { MarketParams } from "./types";

export interface RebalanceLeg {
  id: Hex;
  params: MarketParams;
  current: bigint;
  target: bigint;
  delta: bigint;
  /** Accrued totals, used to derive the expected share price for slippage bounds. */
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
}

export interface BuildBundleInput {
  legs: RebalanceLeg[];
  user: Address;
  chain: Pick<ChainConfig, "generalAdapter1" | "usdc">;
  /** Share-price slippage tolerance in basis points (default 10 = 0.1%). */
  slippageBps?: number;
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
  kind: "withdraw" | "supply" | "skim";
  marketId?: Hex;
  amount: bigint | "max";
  fullExit?: boolean;
}

export interface RebalanceBundle {
  calls: BundleCall[];
  steps: BundleStep[];
  totalWithdraw: bigint;
  totalSupply: bigint;
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
const BPS = 10_000n;

export function buildRebalanceBundle(input: BuildBundleInput): RebalanceBundle {
  const slippageBps = BigInt(input.slippageBps ?? 10);
  const sweep = input.sweepIntoLastSupply ?? true;
  const adapter = input.chain.generalAdapter1;

  const withdraws = input.legs.filter((l) => l.delta < 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));
  const supplies = input.legs.filter((l) => l.delta > 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));

  const totalWithdraw = withdraws.reduce((acc, l) => acc + (l.target === 0n ? l.current : -l.delta), 0n);
  const totalSupply = supplies.reduce((acc, l) => acc + l.delta, 0n);

  if (supplies.length > 0 && totalSupply > totalWithdraw) {
    throw new Error(
      `Bundle would supply ${totalSupply} but only withdraw ${totalWithdraw}; wallet USDC is not part of the portfolio.`,
    );
  }

  const calls: BundleCall[] = [];
  const steps: BundleStep[] = [];

  for (const leg of withdraws) {
    const fullExit = leg.target === 0n;
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
    const maxSharePrice = (sharePriceE27(leg.totalSupplyAssets, leg.totalSupplyShares) * (BPS + slippageBps)) / BPS;
    const data = encodeFunctionData({
      abi: generalAdapter1Abi,
      functionName: "morphoSupply",
      args: [leg.params, useMax ? MAX_UINT256 : leg.delta, 0n, maxSharePrice, input.user, "0x"],
    });
    calls.push(call(adapter, data));
    steps.push({ kind: "supply", marketId: leg.id, amount: useMax ? "max" : leg.delta });
  });

  // Safety skim: return any USDC left in the adapter to the user. No-op when the balance is zero.
  const skimData = encodeFunctionData({
    abi: generalAdapter1Abi,
    functionName: "erc20Transfer",
    args: [input.chain.usdc, input.user, MAX_UINT256],
  });
  calls.push({ ...call(adapter, skimData), skipRevert: true });
  steps.push({ kind: "skim", amount: "max" });

  return { calls, steps, totalWithdraw, totalSupply };
}

export function encodeBundlerMulticall(calls: BundleCall[]): Hex {
  return encodeFunctionData({ abi: bundler3Abi, functionName: "multicall", args: [calls] });
}

function call(to: Address, data: Hex): BundleCall {
  return { to, data, value: 0n, skipRevert: false, callbackHash: ZERO_HASH };
}
