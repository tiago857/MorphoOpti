import { useCallback, useEffect, useMemo, useState } from "react";
import { BaseError, type Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { bundler3Abi } from "../abi/bundler3";
import { morphoAbi } from "../abi/morpho";
import { CHAINS, type SupportedChainId } from "../config/chains";
import { buildRebalanceBundle, type RebalanceBundle, type RebalanceLeg } from "../core/bundle";
import type { AllocationResult } from "../core/optimizer";
import type { Portfolio } from "../core/types";

export type TxPhase =
  | { kind: "idle" }
  | { kind: "simulating" }
  | { kind: "ready"; gas: bigint }
  | { kind: "sim-error"; message: string }
  | { kind: "awaiting-wallet" }
  | { kind: "pending"; hash: Hex }
  | { kind: "mined"; hash: Hex; success: boolean }
  | { kind: "error"; message: string };

export type AuthPhase =
  | { kind: "idle" }
  | { kind: "awaiting-wallet" }
  | { kind: "pending"; hash: Hex }
  | { kind: "error"; message: string };

export interface UseRebalanceArgs {
  chainId: SupportedChainId;
  portfolio: Portfolio | undefined;
  allocation: AllocationResult | undefined;
  onSettled: () => void;
}

export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    const details = err.walk((e) => e instanceof BaseError && "data" in e) as BaseError | null;
    const parts = [err.shortMessage];
    if (details && details !== err && details.shortMessage !== err.shortMessage) parts.push(details.shortMessage);
    if (err.details && !parts.includes(err.details)) parts.push(err.details);
    return parts.join(" — ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function useRebalance({ chainId, portfolio, allocation, onSettled }: UseRebalanceArgs) {
  const chain = CHAINS[chainId];
  const { address, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const [authPhase, setAuthPhase] = useState<AuthPhase>({ kind: "idle" });

  const built = useMemo((): { bundle?: RebalanceBundle; error?: string } => {
    if (!portfolio || !allocation || !address || !allocation.hasChanges) return {};
    const byId = new Map(portfolio.markets.map((m) => [m.id, m]));
    const legs: RebalanceLeg[] = [];
    for (const a of allocation.markets) {
      if (a.delta === 0n) continue;
      const m = byId.get(a.id as Hex);
      if (!m) return { error: `Market ${a.id} missing from portfolio` };
      legs.push({
        id: m.id,
        params: m.params,
        current: a.current,
        target: a.target,
        delta: a.delta,
        totalSupplyAssets: m.state.totalSupplyAssets,
        totalSupplyShares: m.state.totalSupplyShares,
      });
    }
    try {
      return {
        bundle: buildRebalanceBundle({
          legs,
          user: address,
          chain,
          sweepIntoLastSupply: allocation.unallocated === 0n,
        }),
      };
    } catch (err) {
      return { error: describeError(err) };
    }
  }, [portfolio, allocation, address, chain]);

  // A fresh allocation invalidates any prior simulation, but never interrupts an in-flight transaction.
  useEffect(() => {
    setPhase((p) => (p.kind === "ready" || p.kind === "sim-error" || p.kind === "mined" || p.kind === "error" ? { kind: "idle" } : p));
  }, [built.bundle]);

  const simulate = useCallback(async () => {
    if (!built.bundle || !client || !address) return;
    setPhase({ kind: "simulating" });
    try {
      const gas = await client.estimateContractGas({
        address: chain.bundler3,
        abi: bundler3Abi,
        functionName: "multicall",
        args: [built.bundle.calls],
        account: address,
      });
      setPhase({ kind: "ready", gas });
    } catch (err) {
      setPhase({ kind: "sim-error", message: describeError(err) });
    }
  }, [built.bundle, client, address, chain.bundler3]);

  const execute = useCallback(async () => {
    if (!built.bundle || !client || phase.kind !== "ready") return;
    setPhase({ kind: "awaiting-wallet" });
    try {
      const hash = await writeContractAsync({
        chainId,
        address: chain.bundler3,
        abi: bundler3Abi,
        functionName: "multicall",
        args: [built.bundle.calls],
        gas: (phase.gas * 125n) / 100n,
      });
      setPhase({ kind: "pending", hash });
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
      setPhase({ kind: "mined", hash, success: receipt.status === "success" });
      onSettled();
    } catch (err) {
      setPhase({ kind: "error", message: describeError(err) });
    }
  }, [built.bundle, client, phase, writeContractAsync, chainId, chain.bundler3, onSettled]);

  const authorize = useCallback(async () => {
    if (!client) return;
    setAuthPhase({ kind: "awaiting-wallet" });
    try {
      const hash = await writeContractAsync({
        chainId,
        address: chain.morpho,
        abi: morphoAbi,
        functionName: "setAuthorization",
        args: [chain.generalAdapter1, true],
      });
      setAuthPhase({ kind: "pending", hash });
      await client.waitForTransactionReceipt({ hash, confirmations: 1 });
      setAuthPhase({ kind: "idle" });
      onSettled();
    } catch (err) {
      setAuthPhase({ kind: "error", message: describeError(err) });
    }
  }, [client, writeContractAsync, chainId, chain.morpho, chain.generalAdapter1, onSettled]);

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return {
    bundle: built.bundle,
    bundleError: built.error,
    phase,
    authPhase,
    simulate,
    execute,
    authorize,
    reset,
    wrongChain: !!address && walletChainId !== chainId,
    connected: !!address,
  };
}
