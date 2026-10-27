// Telling the two venue kinds apart by their identifier.
//
// A whitelist holds both, because the UI treats them as one list, but they are not interchangeable:
// a Morpho Blue market is identified by a 32-byte id, an ERC-4626 vault by its 20-byte address.
// Passing one where the other is expected does not fail quietly — `Morpho.market(bytes32)` rejects a
// 20-byte argument outright — so anything that consumes a whitelist has to split it first.

/** A Morpho Blue market id: 32 bytes. */
export function isMarketId(id: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(id);
}

/** An ERC-4626 vault address: 20 bytes. */
export function isVaultAddress(id: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(id);
}

/** Split a mixed whitelist into the market ids and vault addresses it contains. */
export function splitVenueIds<T extends string>(ids: readonly T[]): { marketIds: T[]; vaultAddresses: T[] } {
  const marketIds: T[] = [];
  const vaultAddresses: T[] = [];
  for (const id of ids) {
    if (isMarketId(id)) marketIds.push(id);
    else if (isVaultAddress(id)) vaultAddresses.push(id);
    // Anything else is malformed storage and is dropped rather than sent to a contract.
  }
  return { marketIds, vaultAddresses };
}
