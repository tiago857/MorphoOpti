import { parseAbi } from "viem";

export const bundler3Abi = parseAbi([
  "struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }",
  "function multicall(Call[] bundle) payable",
  "function initiator() view returns (address)",
]);
