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
  // Pulls tokens from the bundle initiator; needs an ERC-20 allowance to the adapter. Used only to
  // bring idle wallet capital into a rebalance.
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  // ERC-4626 vaults. Deposits spend the adapter's own balance, so they need no approval from the
  // user; assets == type(uint256).max deposits the whole balance.
  "function erc4626Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, address receiver)",
  // Withdraw/redeem pull the owner's shares, which requires the owner to have approved the adapter
  // on the vault's share token. shares == type(uint256).max redeems the owner's whole balance.
  "function erc4626Withdraw(address vault, uint256 assets, uint256 minSharePriceE27, address receiver, address owner)",
  "function erc4626Redeem(address vault, uint256 shares, uint256 minSharePriceE27, address receiver, address owner)",
]);
