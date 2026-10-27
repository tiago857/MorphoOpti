import { useCallback, useEffect, useMemo, useState } from "react";
import { BaseError, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { bundler3Abi } from "../abi/bundler3";
import { morphoAbi } from "../abi/morpho";
import { CHAINS, type SupportedChainId } from "../config/chains";
import { buildRebalanceBundle, type RebalanceBundle, type RebalanceLeg } from "../core/bundle";
import { erc20ApproveAbi } from "../data/vaultOnchain";
import type { AllocationResult } from "../core/optimizer";
import type { PoolPortfolio } from "../core/pools";

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
  /** The (chain, loan asset) pool this rebalance acts on. Each pool rebalances independently. */
  pool: PoolPortfolio;
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

export function useRebalance({ pool, allocation, onSettled }: UseRebalanceArgs) {
  const chainId = pool.chainId as SupportedChainId;
  const chain = CHAINS[chainId];
  const { address, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const [authPhase, setAuthPhase] = useState<AuthPhase>({ kind: "idle" });

  const built = useMemo((): { bundle?: RebalanceBundle; error?: string } => {
    if (!allocation || !address || !allocation.hasChanges) return {};
    const byId = new Map(pool.markets.map((m) => [m.id.toLowerCase(), m]));
    const vaultById = new Map(pool.vaults.map((v) => [v.id.toLowerCase(), v]));
    const legs: RebalanceLeg[] = [];
    for (const a of allocation.markets) {
      if (a.delta === 0n) continue;
      const key = a.id.toLowerCase();
      const v = vaultById.get(key);
      if (v) {
        legs.push({
          kind: "vault",
          id: v.id,
          current: a.current,
          target: a.target,
          delta: a.delta,
          shares: v.shares,
          totalAssets: v.totalAssets,
          totalShares: v.totalShares,
          asset: v.asset,
        });
        continue;
      }
      const m = byId.get(key);
      if (!m) return { error: `Venue ${a.id} missing from portfolio` };
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
          loanToken: pool.loanToken,
          walletAvailable: pool.idle ?? 0n,
          sweepIntoLastSupply: allocation.unallocated === 0n,
        }),
      };
    } catch (err) {
      return { error: describeError(err) };
    }
  }, [pool, allocation, address, chain]);

  /**
   * Identity of the *plan*: which venues move, in which direction, by roughly how much.
   *
   * The portfolio refetches on a timer, so neither the bundle object nor even its calldata is stable
   * — the share-price bounds are derived from accrued interest and so differ every block. Keying the
   * reset below on either would discard a good simulation about once a minute and leave Rebalance
   * greyed out for no reason. Amounts are compared in whole tokens so a minute of accrued interest
   * does not count as a change, while a real shift in the allocation still does.
   *
   * This is safe because `execute` always sends the freshly built bundle, with current bounds: the
   * simulation proves the plan is executable, it is not the thing being sent.
   */
  const planSignature = useMemo(() => {
    if (!allocation) return "";
    return allocation.markets
      .filter((m) => m.delta !== 0n)
      .map((m) => `${m.id}:${m.delta / 1_000_000n}`)
      .join("|");
  }, [allocation]);

  // A changed allocation invalidates any prior simulation, but never interrupts an in-flight transaction.
  useEffect(() => {
    setPhase((p) =>
      p.kind === "ready" || p.kind === "sim-error" || p.kind === "mined" || p.kind === "error"
        ? { kind: "idle" }
        : p,
    );
  }, [planSignature]);

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

  /**
   * Morpho.setAuthorization is only needed to withdraw from a market on the user's behalf. Supplying
   * spends the adapter's own balance, and vault legs do not touch Morpho at all, so a bundle made
   * purely of vault moves must not be blocked behind it.
   */
  const needsMorphoAuth = useMemo(
    () => (built.bundle?.steps ?? []).some((s) => s.kind === "withdraw"),
    [built.bundle],
  );

  // Only vault exits need an allowance; the bundle itself reports which, and how many shares.
  const pendingApprovals = useMemo(() => {
    const required = built.bundle?.requiresApproval ?? [];
    return required.filter((r) => {
      const v = pool.vaults.find((x) => x.id.toLowerCase() === r.vault.toLowerCase());
      return !v || v.allowance < r.shares;
    });
  }, [built.bundle, pool.vaults]);

  const approveVault = useCallback(
    async (vault: Address, shares: bigint) => {
      if (!client) return;
      setAuthPhase({ kind: "awaiting-wallet" });
      try {
        const hash = await writeContractAsync({
          chainId,
          address: vault,
          abi: erc20ApproveAbi,
          functionName: "approve",
          // Exactly the shares this bundle redeems, not an unlimited allowance. A later rebalance
          // that exits the same vault asks again, which is the price of not leaving a standing claim
          // on the position.
          args: [chain.generalAdapter1, shares],
        });
        setAuthPhase({ kind: "pending", hash });
        await client.waitForTransactionReceipt({ hash, confirmations: 1 });
        setAuthPhase({ kind: "idle" });
        onSettled();
      } catch (err) {
        setAuthPhase({ kind: "error", message: describeError(err) });
      }
    },
    [client, writeContractAsync, chainId, chain.generalAdapter1, onSettled],
  );

  /**
   * Deploying wallet capital needs the adapter to pull the loan token. The bundle pulls only the
   * shortfall its supplies need, which drifts by a few units as positions accrue, so the approval is
   * for the idle balance being deployed — the ceiling the bundle can never exceed — rather than a
   * figure that would be stale by the next refresh. Never unlimited.
   */
  const tokenApproval = useMemo(() => {
    const pull = built.bundle?.walletPull ?? 0n;
    if (pull === 0n) return undefined;
    const allowance = pool.wallet?.allowance ?? 0n;
    const ceiling = pool.idle ?? pull;
    return allowance >= pull ? undefined : { token: pool.loanToken, amount: ceiling > pull ? ceiling : pull };
  }, [built.bundle, pool.wallet, pool.idle, pool.loanToken]);

  const approveToken = useCallback(async () => {
    if (!client || !tokenApproval) return;
    setAuthPhase({ kind: "awaiting-wallet" });
    try {
      const hash = await writeContractAsync({
        chainId,
        address: tokenApproval.token,
        abi: erc20ApproveAbi,
        functionName: "approve",
        // The idle balance being deployed, never an unlimited allowance.
        args: [chain.generalAdapter1, tokenApproval.amount],
      });
      setAuthPhase({ kind: "pending", hash });
      await client.waitForTransactionReceipt({ hash, confirmations: 1 });
      setAuthPhase({ kind: "idle" });
      onSettled();
    } catch (err) {
      setAuthPhase({ kind: "error", message: describeError(err) });
    }
  }, [client, tokenApproval, writeContractAsync, chainId, chain.generalAdapter1, onSettled]);

  const switchToChain = useCallback(async () => {
    try {
      await switchChainAsync({ chainId });
    } catch (err) {
      setPhase({ kind: "error", message: describeError(err) });
    }
  }, [switchChainAsync, chainId]);

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return {
    bundle: built.bundle,
    bundleError: built.error,
    phase,
    authPhase,
    simulate,
    execute,
    authorize,
    needsMorphoAuth,
    approveVault,
    pendingApprovals,
    tokenApproval,
    approveToken,
    switchToChain,
    reset,
    wrongChain: !!address && walletChainId !== chainId,
    connected: !!address,
  };
}
