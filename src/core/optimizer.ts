// Allocation optimizer: greedy marginal water-filling over whitelisted markets with a per-market cap,
// using the Adaptive Curve IRM to model how the user's own supply moves each market's utilization.

import { supplyApy, TARGET_UTILIZATION, utilization } from "./irm";
import { wadToNumber } from "./math";

export interface OptimizerMarketInput {
  id: string;
  /** Accrued totals, in loan-token units. */
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  feeWad: bigint;
  /** Per-second rate at target utilization, WAD. */
  rateAtTargetWad: bigint;
  /** Sum of reward supply APRs (fraction) as currently reported. */
  rewardApr: number;
  /** User's current supplied assets in this market. */
  position: bigint;
  whitelisted: boolean;
  /**
   * Markets whose yield cannot be modelled (non-Adaptive-Curve IRM) are held at their current
   * allocation instead of being assumed to earn nothing.
   */
  pinned?: boolean;
}

export interface OptimizerOptions {
  /** Default per-market cap as a fraction of the portfolio (0.10). */
  capFraction?: number;
  /** Number of greedy steps used to discretise the portfolio (2000). */
  steps?: number;
  /** Deltas smaller than this (token units) are dropped (1 USDC). */
  dustThreshold?: bigint;
}

export interface MarketAllocation {
  id: string;
  whitelisted: boolean;
  pinned: boolean;
  current: bigint;
  target: bigint;
  delta: bigint;
  cap: bigint;
  liquidityFloor: bigint;
  currentNativeApy: number;
  currentRewardApr: number;
  currentApy: number;
  projectedNativeApy: number;
  projectedRewardApr: number;
  projectedApy: number;
}

export interface AllocationResult {
  total: bigint;
  /** Effective cap fraction after the 1/N adjustment. */
  effectiveCapFraction: number;
  markets: MarketAllocation[];
  portfolioApyNow: number;
  portfolioApyProjected: number;
  /** USDC that could not be placed within caps (returned to wallet by the bundle skim). */
  unallocated: bigint;
  hasChanges: boolean;
  warnings: string[];
}

interface Work {
  input: OptimizerMarketInput;
  /** Supply from everyone except the user. */
  sExt: number;
  b: number;
  fee: number;
  rT: number;
  /** Annual reward budget in token units (rewardApr * current total supply). */
  rewardBudget: number;
  pos: number;
  cap: number;
  floor: number;
  x: number;
}

const DEFAULTS = { capFraction: 0.1, steps: 2000, dustThreshold: 1_000_000n };

/** Annual yield (token units) earned by allocation `x` in market `m`, including own price impact. */
function yieldAt(m: Work, x: number): number {
  if (x <= 0) return 0;
  const total = m.sExt + x;
  if (total <= 0) return 0;
  const u = utilization(total, m.b);
  const native = x * supplyApy(u, m.rT, m.fee);
  const rewards = m.rewardBudget * (x / total);
  return native + rewards;
}

/** Allocation that puts the market exactly at target utilisation (may be negative or above cap). */
function kinkAllocation(m: Work): number {
  return m.b / TARGET_UTILIZATION - m.sExt;
}

function nativeApyAt(m: Work, x: number): number {
  const total = m.sExt + x;
  if (total <= 0) return 0;
  return supplyApy(utilization(total, m.b), m.rT, m.fee);
}

function rewardAprAt(m: Work, x: number): number {
  const total = m.sExt + x;
  if (total <= 0) return 0;
  return m.rewardBudget / total;
}

export function optimizeAllocation(
  inputs: OptimizerMarketInput[],
  options: OptimizerOptions = {},
): AllocationResult {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];

  const total = inputs.reduce((acc, m) => acc + m.position, 0n);
  const T = Number(total);
  // Pinned markets cannot receive capital, so they do not count towards the 1/N cap adjustment.
  const nWhitelisted = inputs.filter((m) => m.whitelisted && !m.pinned).length;
  const effectiveCapFraction = nWhitelisted > 0 ? Math.max(opts.capFraction, 1 / nWhitelisted) : 0;

  if (effectiveCapFraction > opts.capFraction + 1e-12) {
    warnings.push(
      `Only ${nWhitelisted} markets whitelisted; cap raised to ${(effectiveCapFraction * 100).toFixed(1)}% each.`,
    );
  }

  if (total === 0n) {
    return {
      total,
      effectiveCapFraction,
      markets: inputs.map((m) => emptyAllocation(m)),
      portfolioApyNow: 0,
      portfolioApyProjected: 0,
      unallocated: 0n,
      hasChanges: false,
      warnings: [...warnings, "No USDC supplied in any market for this address."],
    };
  }

  const work: Work[] = inputs.map((m) => {
    const S = Number(m.totalSupplyAssets);
    const B = Number(m.totalBorrowAssets);
    const pos = Number(m.position);
    const liquidity = Math.max(0, S - B);
    // A pinned market is frozen at its current allocation: floor == cap == position.
    const floor = m.pinned ? pos : Math.max(0, pos - liquidity);
    const cap = m.pinned ? pos : m.whitelisted ? effectiveCapFraction * T : 0;
    return {
      input: m,
      sExt: Math.max(0, S - pos),
      b: B,
      fee: wadToNumber(m.feeWad),
      rT: wadToNumber(m.rateAtTargetWad),
      rewardBudget: m.rewardApr * S,
      pos,
      cap,
      floor,
      x: floor,
    };
  });

  for (const m of work) {
    if (m.input.pinned && m.pos > 0) {
      warnings.push(
        `Market ${m.input.id.slice(0, 10)}… uses a non-standard interest rate model; its ${fmt(m.pos)} USDC is held in place.`,
      );
      continue;
    }
    if (m.floor > m.cap + 0.5) {
      warnings.push(
        `Market ${m.input.id.slice(0, 10)}… lacks liquidity to withdraw fully; ${fmt(m.floor)} USDC must stay.`,
      );
    }
  }

  // Greedy water-filling. The chunk shrinks to the largest remaining head-room so caps can be hit exactly.
  let remaining = T - work.reduce((acc, m) => acc + m.floor, 0);
  const step = Math.max(Math.floor(remaining / opts.steps), 1);
  while (remaining >= 1) {
    const maxRoom = Math.max(0, ...work.map((m) => Math.floor(m.cap - m.x)));
    if (maxRoom < 1) break;
    const d = Math.max(1, Math.min(step, Math.floor(remaining), maxRoom));
    let best = -1;
    let bestGain = -Infinity;
    for (let i = 0; i < work.length; i++) {
      const m = work[i];
      if (m.x + d > m.cap + 1e-6) continue;
      const gain = yieldAt(m, m.x + d) - yieldAt(m, m.x);
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    if (best < 0) break;
    work[best].x += d;
    remaining -= d;
  }

  // Pairwise improvement pass. The IRM curve has a convex kink at 90% utilisation, so besides fixed
  // chunks we also try the largest feasible move and the move that lands a market exactly at target
  // utilisation (where the steep part of the curve ends).
  for (let iter = 0; iter < 50; iter++) {
    let improved = false;
    for (const from of work) {
      for (const to of work) {
        if (to === from) continue;
        const maxMove = Math.floor(Math.min(from.x - from.floor, to.cap - to.x));
        if (maxMove < 1) continue;
        const candidates = new Set<number>([maxMove, Math.floor(maxMove / 2), Math.floor(maxMove / 4), step * 100, step * 10, step]);
        const toKink = Math.ceil(kinkAllocation(to) - to.x);
        if (toKink >= 1) candidates.add(toKink);
        const fromKink = Math.floor(from.x - kinkAllocation(from));
        if (fromKink >= 1) candidates.add(fromKink);
        const before = yieldAt(from, from.x) + yieldAt(to, to.x);
        let bestD = 0;
        let bestAfter = before + 1e-9;
        for (const d of candidates) {
          if (d < 1 || d > maxMove) continue;
          const after = yieldAt(from, from.x - d) + yieldAt(to, to.x + d);
          if (after > bestAfter) {
            bestAfter = after;
            bestD = d;
          }
        }
        if (bestD > 0) {
          from.x -= bestD;
          to.x += bestD;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // Round to token units and fix the sum.
  const targets = work.map((m) => BigInt(Math.round(m.x)));
  let placed = targets.reduce((a, b) => a + b, 0n);
  // Sub-dust leftovers (from fractional caps) are folded into the largest position instead of being skimmed.
  let unallocated = BigInt(Math.round(remaining));
  if (unallocated < opts.dustThreshold) unallocated = 0n;
  let diff = total - unallocated - placed;
  if (diff !== 0n) {
    const idx = indexOfLargest(targets, (i) => work[i].input.whitelisted);
    if (idx >= 0) targets[idx] += diff;
  }

  // Drop dust legs, then re-fix the sum on the largest supply leg.
  const deltas = targets.map((t, i) => t - inputs[i].position);
  for (let i = 0; i < deltas.length; i++) {
    const abs = deltas[i] < 0n ? -deltas[i] : deltas[i];
    if (abs !== 0n && abs < opts.dustThreshold) {
      targets[i] = inputs[i].position;
      deltas[i] = 0n;
    }
  }
  placed = targets.reduce((a, b) => a + b, 0n);
  diff = total - unallocated - placed;
  if (diff !== 0n) {
    let idx = indexOfLargest(deltas, (i) => deltas[i] > 0n);
    if (idx < 0) idx = indexOfLargest(deltas.map((d) => -d), (i) => deltas[i] < 0n);
    if (idx >= 0) {
      targets[idx] += diff;
      deltas[idx] += diff;
    }
  }

  if (unallocated > 0n) {
    warnings.push(`${fmt(Number(unallocated))} USDC cannot be placed within caps and will be returned to the wallet.`);
  }

  const markets: MarketAllocation[] = work.map((m, i) => {
    const target = Number(targets[i]);
    const currentNativeApy = nativeApyAt(m, m.pos);
    const currentRewardApr = m.input.rewardApr;
    const projectedNativeApy = nativeApyAt(m, target);
    const projectedRewardApr = rewardAprAt(m, target);
    return {
      id: m.input.id,
      whitelisted: m.input.whitelisted,
      pinned: !!m.input.pinned,
      current: m.input.position,
      target: targets[i],
      delta: deltas[i],
      cap: BigInt(Math.floor(m.cap)),
      liquidityFloor: BigInt(Math.ceil(m.floor)),
      currentNativeApy,
      currentRewardApr,
      currentApy: currentNativeApy + currentRewardApr,
      projectedNativeApy,
      projectedRewardApr,
      projectedApy: projectedNativeApy + projectedRewardApr,
    };
  });

  const portfolioApyNow = work.reduce((acc, m, i) => acc + m.pos * markets[i].currentApy, 0) / T;
  const portfolioApyProjected = work.reduce((acc, m, i) => acc + yieldAt(m, Number(targets[i])), 0) / T;

  return {
    total,
    effectiveCapFraction,
    markets,
    portfolioApyNow,
    portfolioApyProjected,
    unallocated,
    hasChanges: deltas.some((d) => d !== 0n),
    warnings,
  };
}

function emptyAllocation(m: OptimizerMarketInput): MarketAllocation {
  return {
    id: m.id,
    whitelisted: m.whitelisted,
    pinned: !!m.pinned,
    current: m.position,
    target: m.position,
    delta: 0n,
    cap: 0n,
    liquidityFloor: 0n,
    currentNativeApy: 0,
    currentRewardApr: m.rewardApr,
    currentApy: m.rewardApr,
    projectedNativeApy: 0,
    projectedRewardApr: m.rewardApr,
    projectedApy: m.rewardApr,
  };
}

function indexOfLargest(values: bigint[], eligible: (i: number) => boolean): number {
  let idx = -1;
  for (let i = 0; i < values.length; i++) {
    if (!eligible(i)) continue;
    if (idx < 0 || values[i] > values[idx]) idx = i;
  }
  return idx;
}

function fmt(units: number): string {
  return (units / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
