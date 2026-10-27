import { USDC_DECIMALS } from "../config/chains";

// Every managed loan asset (USDC, USDT, aUSD) is 6-decimal, so one scale serves them all.
const SCALE = 10 ** USDC_DECIMALS;

export function unitsToNumber(units: bigint): number {
  return Number(units) / SCALE;
}

export function fmtAmount(units: bigint, digits = 2): string {
  return unitsToNumber(units).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtDelta(units: bigint, digits = 2): string {
  if (units === 0n) return "—";
  const sign = units > 0n ? "+" : "−";
  return `${sign}${fmtAmount(units < 0n ? -units : units, digits)}`;
}

export function fmtPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

/**
 * APY for the market list. Dust markets at 100% utilisation can print five-figure percentages, which
 * would overflow the column, so anything absurd collapses to a marker rather than a precise number.
 */
export function fmtApy(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const pct = x * 100;
  if (pct >= 1000) return ">999%";
  if (pct <= -1000) return "<-999%";
  if (pct >= 100) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(2)}%`;
}

export function fmtShare(part: bigint, total: bigint): string {
  if (total === 0n) return "—";
  return fmtPct(Number(part) / Number(total), 1);
}

export function fmtUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
