import { parseAbi } from "viem";

export const generalAdapter1Abi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  // Supplies from the adapter's own loan-token balance. assets == type(uint256).max supplies the whole balance.
  "function morphoSupply(MarketParams marketParams, uint256 assets, uint256 shares, uint256 maxSharePriceE27, address onBehalf, bytes data)",
  // Withdraws on behalf of the bundle initiator (requires Morpho.setAuthorization(adapter, true)).
  // shares == type(uint256).max withdraws the initiator's whole position.
  "function morphoWithdraw(MarketParams marketParams, uint256 assets, uint256 shares, uint256 minSharePriceE27, address receiver)",
  // amount == type(uint256).max transfers the adapter's whole balance.
  "function erc20Transfer(address token, address receiver, uint256 amount)",
]);
