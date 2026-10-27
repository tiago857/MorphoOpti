import { describe, expect, it } from "vitest";
import { isMarketId, isVaultAddress, splitVenueIds } from "./venue";

const MARKET = `0x${"a".repeat(64)}`;
const VAULT = "0x08c00f8279dff5b0cb5a04d349e7d79708ceadf3";

describe("venue ids", () => {
  it("recognises a 32-byte market id", () => {
    expect(isMarketId(MARKET)).toBe(true);
    expect(isMarketId(VAULT)).toBe(false);
  });

  it("recognises a 20-byte vault address", () => {
    expect(isVaultAddress(VAULT)).toBe(true);
    expect(isVaultAddress(MARKET)).toBe(false);
  });

  it("accepts either case", () => {
    expect(isVaultAddress(VAULT.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isMarketId(MARKET.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("splits a mixed whitelist", () => {
    const { marketIds, vaultAddresses } = splitVenueIds([MARKET, VAULT, MARKET]);
    expect(marketIds).toEqual([MARKET, MARKET]);
    expect(vaultAddresses).toEqual([VAULT]);
  });

  it("drops malformed entries rather than passing them to a contract", () => {
    // This is the shape that crashed Morpho.market(bytes32) when a vault address reached it.
    const { marketIds, vaultAddresses } = splitVenueIds(["0xdeadbeef", "", "not-hex", VAULT]);
    expect(marketIds).toEqual([]);
    expect(vaultAddresses).toEqual([VAULT]);
  });

  it("keeps a vault address out of the market id list", () => {
    expect(splitVenueIds([VAULT]).marketIds).toEqual([]);
  });
});
