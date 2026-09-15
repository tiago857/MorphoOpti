// Check which public RPC endpoints tolerate the app's read pattern (a 24-call multicall).
import { createPublicClient, http, parseAbi } from "viem";
import { base, mainnet } from "viem/chains";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const USDC = { 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const IRM = { 1: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC", 8453: "0x46415998764C29aB2a25CbeA6254146D50D22687" };

const ENDPOINTS = {
  1: [
    "https://eth.llamarpc.com",
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://eth.drpc.org",
    "https://cloudflare-eth.com",
    "https://rpc.flashbots.net",
  ],
  8453: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://rpc.ankr.com/base",
    "https://base.meowrpc.com",
  ],
};

const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)",
]);
const irmAbi = parseAbi(["function rateAtTarget(bytes32 id) view returns (int256)"]);

for (const [chainId, urls] of Object.entries(ENDPOINTS)) {
  const chain = chainId === "1" ? mainnet : base;
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query { markets(first: 12, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [${chainId}], loanAssetAddress_in: ["${USDC[chainId].toLowerCase()}"], listed: true }) { items { marketId collateralAsset { symbol } } } }`,
    }),
  });
  const ids = (await res.json()).data.markets.items.filter((m) => m.collateralAsset).map((m) => m.marketId);

  console.log(`\n=== chain ${chainId} (${ids.length} markets, ${ids.length * 3} calls) ===`);
  for (const url of urls) {
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 1, timeout: 15000 }) });
    const t0 = Date.now();
    try {
      const out = await client.multicall({
        allowFailure: false,
        contracts: ids.flatMap((id) => [
          { address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] },
          { address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] },
          { address: IRM[chainId], abi: irmAbi, functionName: "rateAtTarget", args: [id] },
        ]),
      });
      console.log(`  OK    ${String(Date.now() - t0).padStart(6)}ms  ${url}  (${out.length} results)`);
    } catch (e) {
      console.log(`  FAIL  ${String(Date.now() - t0).padStart(6)}ms  ${url}  ${(e.details ?? e.shortMessage ?? e.message).split("\n")[0].slice(0, 70)}`);
    }
  }
}
