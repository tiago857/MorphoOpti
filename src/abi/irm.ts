import { parseAbi } from "viem";

export const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function rateAtTarget(bytes32 id) view returns (int256)",
  "function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)",
]);
