// Fixed-point helpers mirroring Morpho Blue's MathLib / SharesMathLib.

export const WAD = 10n ** 18n;
export const RAY = 10n ** 27n;
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;
export const MAX_UINT256 = 2n ** 256n - 1n;
export const SECONDS_PER_YEAR = 31_536_000;

export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}

export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d;
}

export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD);
}

export function wDivDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, WAD, y);
}

export function wDivUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, WAD, y);
}

/** Continuous compounding approximated by the first three Taylor terms, as Morpho does on-chain. */
export function wTaylorCompounded(ratePerSecondWad: bigint, elapsedSeconds: bigint): bigint {
  const firstTerm = ratePerSecondWad * elapsedSeconds;
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD);
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
}

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}

export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}

export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

/** Supply share price scaled to 27 decimals, matching the adapter's rDivUp/rDivDown slippage checks. */
export function sharePriceE27(totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(totalAssets + VIRTUAL_ASSETS, RAY, totalShares + VIRTUAL_SHARES);
}

export function wadToNumber(x: bigint): number {
  return Number(x) / 1e18;
}

export function bigintAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
