import { encodeAbiParameters, keccak256, type Hex } from "viem";
import type { MarketParams } from "./types";

/** Morpho Blue market id: keccak256(abi.encode(marketParams)). */
export function marketId(params: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
    ),
  );
}

export function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
