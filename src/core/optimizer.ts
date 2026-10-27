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
   * Fixed supply rate for venues with no IRM curve to simulate — a vault, whose yield comes from its
   * own internal allocation. When set, the rate is used as-is at any size, and totalSupplyAssets is
   * treated purely as the external supply that dilutes rewards.
   */
  flatApy?: number;
  /**
   * Per-market cap as a fraction of the pool, overriding the pool default (and the 1/N adjustment).
   */
  capFraction?: number;
  /**
   * Capital tied up in a loop in this market. The optimizer never withdraws below it, and it counts
   * towards exposure: a locked amount above the cap raises the cap rather than forcing a withdrawal.
   */
  locked?: bigint;
  /**
   * Markets whose yield cannot be modelled (non-Adaptive-Curve IRM) are held at their current
   * allocation instead of being assumed to earn nothing.
   */
  pinned?: boolean;
  /**
   * Markets with no usable free liquidity: their headline APY is a utilization spike, and new
   * supply could be borrowed straight out and stuck. They may be exited but never receive capital.
   */
  noInflow?: boolean;
  /** Why the market is closed to inflows, in numbers, shown to the user against the market. */
  noInflowReason?: string;
}

export interface OptimizerOptions {
  /** Default per-market cap as a fraction of the portfolio (0.10). */
  capFraction?: number;
  /** Number of greedy steps used to discretise the portfolio (2000). */
  steps?: number;
  /** Deltas smaller than this (token units) are dropped (1 unit of the loan asset). */
  dustThreshold?: bigint;
  /** Loan-asset symbol, used only in warning text. */
  symbol?: string;
  /**
   * Idle loan token in the wallet that the user chose to deploy. It joins the pool as capital with
   * no current home: it counts towards the total that caps are measured against, earns nothing in
   * "now", and is placed like any other capital.
   */
  idle?: bigint;
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
  /** Capital held in place because it is locked in a loop. */
  locked: bigint;
  /** True when `locked` pushed this market above its configured cap. */
  overCap: boolean;
  /**
   * What is wrong with this market specifically, one sentence each, with amounts. Shown against the
   * market itself; `AllocationResult.warnings` keeps only pool-wide notices.
   */
  issues: string[];
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
  /** Capital that could not be placed within caps (returned to wallet by the bundle skim). */
  unallocated: bigint;
  /** Wallet capital included in `total` (0 when idle deployment is off). */
  idle: bigint;
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
  /** Fixed rate for a venue with no IRM curve (a vault); undefined for a market. */
  flat?: number;
  /** Annual reward budget in token units (rewardApr * current total supply). */
  rewardBudget: number;
  pos: number;
  /** Cap actually enforced: the configured cap, raised to `floor` when capital cannot be moved. */
  cap: number;
  /** Minimum this market may hold: the larger of the liquidity floor and the locked amount. */
  floor: number;
  /** Cap from settings alone, before locked/illiquid capital forces it up. */
  configuredCap: number;
  /** Floor imposed by market liquidity alone, ignoring locked capital. */
  liquidityFloor: number;
  locked: number;
  overCap: boolean;
  x: number;
}

const DEFAULTS = { capFraction: 0.1, steps: 2000, dustThreshold: 1_000_000n, symbol: "USDC", idle: 0n };

/** Annual yield (token units) earned by allocation `x` in market `m`, including own price impact. */
function yieldAt(m: Work, x: number): number {
  if (x <= 0) return 0;
  const total = m.sExt + x;
  if (total <= 0) return 0;
  // A flat-rate venue still dilutes its reward budget, it just does not move its own base rate.
  const native = m.flat !== undefined ? x * m.flat : x * supplyApy(utilization(total, m.b), m.rT, m.fee);
  const rewards = m.rewardBudget * (x / total);
  return native + rewards;
}

/** Allocation that puts the market exactly at target utilisation (may be negative or above cap). */
function kinkAllocation(m: Work): number {
  return m.b / TARGET_UTILIZATION - m.sExt;
}

function nativeApyAt(m: Work, x: number): number {
  if (m.flat !== undefined) return m.flat;
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

  const idle = opts.idle > 0n ? opts.idle : 0n;
  const deployed = inputs.reduce((acc, m) => acc + m.position, 0n);
  // Caps are a share of everything being allocated, wallet capital included; otherwise adding idle
  // funds would leave the cap sized for half the money and strand the rest as unplaceable.
  const total = deployed + idle;
  const T = Number(total);
  // Pinned and noInflow markets cannot receive capital, so they do not count as places to put it.
  const nWhitelisted = inputs.filter((m) => m.whitelisted && !m.pinned && !m.noInflow).length;
  // When there are too few markets for the default cap to hold all the capital (5 markets at 10% only
  // fit half of it), the cap is switched off for this pool rather than raised to an even 1/N split:
  // an even split ignores yield entirely, and the user wants the money where it earns most — with a
  // single market, that is 100% in it. Explicit per-market caps still apply.
  const capFits = nWhitelisted * opts.capFraction >= 1 - 1e-9;
  const effectiveCapFraction = nWhitelisted === 0 ? 0 : capFits ? opts.capFraction : 1;

  if (nWhitelisted > 0 && !capFits) {
    const needed = Math.ceil(1 / opts.capFraction - 1e-9);
    warnings.push(
      `Only ${nWhitelisted} ${nWhitelisted === 1 ? "market" : "markets"} whitelisted, fewer than the ${needed} a ` +
        `${(opts.capFraction * 100).toFixed(0)}% cap needs, so the cap is off in this pool and capital goes where it ` +
        `earns most. Whitelist at least ${needed} markets to apply it.`,
    );
  }

  // When the number of whitelisted markets times the cap is exactly 1, every market is pinned at the
  // cap and the allocation is fully determined before any yield is considered. Say so, because the
  // optimizer silently doing nothing looks identical to the optimizer working.
  const headroom = nWhitelisted * effectiveCapFraction;
  if (nWhitelisted > 1 && headroom < 1 + 1e-9) {
    warnings.push(
      `${nWhitelisted} whitelisted markets at a ${(effectiveCapFraction * 100).toFixed(1)}% cap fills exactly ` +
        `${(headroom * 100).toFixed(0)}% of the pool, so every market is pinned at its cap and yield cannot be ` +
        `optimised. Whitelist more markets, or raise the cap, to let the allocation actually choose.`,
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
      idle: 0n,
      hasChanges: false,
      warnings: [...warnings, `No ${opts.symbol} supplied in any market for this address.`],
    };
  }

  const work: Work[] = inputs.map((m) => {
    const S = Number(m.totalSupplyAssets);
    const B = Number(m.totalBorrowAssets);
    const pos = Number(m.position);
    const liquidity = Math.max(0, S - B);
    // Locked capital sits in a loop: it can never be withdrawn, and it can never exceed what is
    // actually supplied here.
    const locked = Math.min(Number(m.locked ?? 0n), pos);
    // A per-market cap overrides the pool default, including the 1/N adjustment.
    const capFraction = m.capFraction ?? effectiveCapFraction;
    const whitelistCap = m.pinned ? pos : m.whitelisted ? capFraction * T : 0;
    const configuredCap = m.noInflow ? Math.min(whitelistCap, pos) : whitelistCap;
    // A pinned market is frozen at its current allocation: floor == cap == position.
    const liquidityFloor = m.pinned ? pos : Math.max(0, pos - liquidity);
    // Locked wins over the cap: hold the capital and let the market sit above cap rather than
    // emitting a withdrawal that would break the loop.
    const floor = Math.max(liquidityFloor, locked);
    const cap = Math.max(configuredCap, floor);
    return {
      input: m,
      sExt: Math.max(0, S - pos),
      b: B,
      fee: wadToNumber(m.feeWad),
      rT: wadToNumber(m.rateAtTargetWad),
      flat: m.flatApy,
      rewardBudget: m.rewardApr * S,
      pos,
      cap,
      floor,
      configuredCap,
      liquidityFloor,
      locked,
      overCap: locked > configuredCap + 0.5,
      x: floor,
    };
  });

  const issues: string[][] = work.map((m) => {
    const out: string[] = [];
    if (m.input.pinned) {
      if (m.pos > 0) {
        out.push(
          `Uses a non-standard interest rate model, so its yield cannot be modelled; your ${fmt(m.pos)} ${opts.symbol} here is held in place.`,
        );
      }
      return out;
    }
    if (m.input.noInflow && m.input.whitelisted) {
      out.push(
        `${m.input.noInflowReason ?? "Too little free liquidity."} Receives no new ${opts.symbol} even though it is whitelisted.`,
      );
    }
    if (m.overCap) {
      out.push(
        `${fmt(m.locked)} ${opts.symbol} is locked in a loop here, above the ${fmt(m.configuredCap)} ${opts.symbol} cap; it is held in place and the cap is not enforced.`,
      );
    }
    if (m.liquidityFloor > m.configuredCap + 0.5) {
      out.push(
        `Only ${fmt(Math.max(0, m.sExt + m.pos - m.b))} ${opts.symbol} liquidity available, so ${fmt(m.liquidityFloor)} of your ${fmt(m.pos)} ${opts.symbol} cannot be withdrawn right now and must stay.`,
      );
    }
    return out;
  });

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
        if (to.flat === undefined) {
          const toKink = Math.ceil(kinkAllocation(to) - to.x);
          if (toKink >= 1) candidates.add(toKink);
        }
        if (from.flat === undefined) {
          const fromKink = Math.floor(from.x - kinkAllocation(from));
          if (fromKink >= 1) candidates.add(fromKink);
        }
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
    warnings.push(
      `${fmt(Number(unallocated))} ${opts.symbol} cannot be placed within caps and will be returned to the wallet.`,
    );
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
      liquidityFloor: BigInt(Math.ceil(m.liquidityFloor)),
      locked: BigInt(Math.round(m.locked)),
      overCap: m.overCap,
      issues: issues[i],
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
    idle,
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
    locked: 0n,
    overCap: false,
    issues: [],
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
