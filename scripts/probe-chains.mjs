// Probe candidate RPCs with this app's real read pattern: batched multicall of Morpho market state
// plus IRM reads, all in one request.
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrum, base, hyperEvm, mainnet, monad } from "viem/chains";

const morphoAbi = parseAbi([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
]);
const irmAbi = parseAbi([
  "function rateAtTarget(bytes32) view returns (int256)",
]);

const CHAINS = {
  1: { chain: mainnet, morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
       rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  8453: { chain: base, morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
       rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"] },
  42161: { chain: arbitrum, morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e", irm: "0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA",
       rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org", "https://arb1.arbitrum.io/rpc"] },
  999: { chain: hyperEvm, morpho: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD", irm: "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483",
       rpcs: ["https://rpc.hyperliquid.xyz/evm", "https://hyperliquid.drpc.org", "https://rpc.hypurrscan.io"] },
  143: { chain: monad, morpho: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee", irm: "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
       rpcs: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://monad.drpc.org"] },
};

async function marketIds(chainId, n = 8) {
  const r = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($id: Int!, $n: Int!) { markets(first: $n, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [$id], listed: true }) { items { marketId collateralAsset { symbol } } } }`,
      variables: { id: chainId, n },
    }),
  });
  const j = await r.json();
  return j.data.markets.items.filter((m) => m.collateralAsset).map((m) => m.marketId);
}

for (const [id, cfg] of Object.entries(CHAINS)) {
  const ids = await marketIds(Number(id));
  console.log(`\n=== chain ${id} (${cfg.chain.name}) — ${ids.length} market ids ===`);
  for (const url of cfg.rpcs) {
    const client = createPublicClient({
      chain: cfg.chain,
      transport: http(url, { timeout: 15_000, retryCount: 1, batch: { wait: 50 } }),
    });
    const t0 = Date.now();
    try {
      const code = await client.getCode({ address: cfg.morpho });
      const res = await client.multicall({
        allowFailure: false,
        contracts: [
          ...ids.flatMap((i) => [
            { address: cfg.morpho, abi: morphoAbi, functionName: "market", args: [i] },
            { address: cfg.morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [i] },
          ]),
          ...ids.map((i) => ({ address: cfg.irm, abi: irmAbi, functionName: "rateAtTarget", args: [i] })),
        ],
      });
      const blue = code && code !== "0x" ? `${code.length / 2 - 1}B` : "NO CODE";
      console.log(`  OK   ${String(Date.now() - t0).padStart(5)}ms  ${url}  (morpho ${blue}, ${res.length} results)`);
    } catch (e) {
      console.log(`  FAIL ${String(Date.now() - t0).padStart(5)}ms  ${url}  ${(e.shortMessage ?? e.message).slice(0, 90)}`);
    }
  }
}
