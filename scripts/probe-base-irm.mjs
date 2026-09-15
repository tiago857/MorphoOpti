// Determine whether the Base IRM reads genuinely revert or were just rate-limited inside a
// multicall chunk (viem reports a failed chunk as per-call errors when allowFailure is true).
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function rateAtTarget(bytes32 id) view returns (int256)",
  "function borrowRateView(MarketParams, Market) view returns (uint256)",
]);
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)",
]);

const client = createPublicClient({
  chain: base,
  transport: http(process.env.RPC_BASE || undefined, { retryCount: 10, retryDelay: 2000 }),
});

const res = await fetch("https://api.morpho.org/graphql", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query: `query { markets(first: 12, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [8453], loanAssetAddress_in: ["${USDC.toLowerCase()}"], listed: true }) { items { marketId collateralAsset { symbol } state { supplyApy } } } }`,
  }),
});
const items = (await res.json()).data.markets.items.filter((m) => m.collateralAsset);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECONDS_PER_YEAR = 31536000;
const curve = (u) => {
  const err = u > 0.9 ? (u - 0.9) / 0.1 : (u - 0.9) / 0.9;
  return err >= 0 ? 1 + 3 * err : 1 + 0.75 * err;
};

console.log("Sequential one-at-a-time reads (no multicall batching):\n");
console.log("collateral".padEnd(12) + "apiAPY".padStart(9) + "calcAPY".padStart(9) + "diff".padStart(8) + "  rateAtTarget");
for (const it of items) {
  try {
    const id = it.marketId;
    const [m, mp, rT] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] }),
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] }),
      client.readContract({ address: IRM, abi: irmAbi, functionName: "rateAtTarget", args: [id] }),
    ]);
    const S = Number(m[0]) / 1e6;
    const B = Number(m[2]) / 1e6;
    const u = S > 0 ? B / S : 0;
    const fee = Number(m[5]) / 1e18;
    const rt = Number(rT) / 1e18;
    const calc = (Math.exp(rt * curve(u) * SECONDS_PER_YEAR) - 1) * u * (1 - fee);
    const api = it.state.supplyApy;
    console.log(
      it.collateralAsset.symbol.padEnd(12) +
        (api * 100).toFixed(2).padStart(9) +
        (calc * 100).toFixed(2).padStart(9) +
        ((calc - api) * 100).toFixed(2).padStart(8) +
        "  " +
        rT.toString() +
        (mp[3].toLowerCase() === IRM.toLowerCase() ? "" : "  (different IRM!)"),
    );
  } catch (e) {
    console.log(it.collateralAsset.symbol.padEnd(12) + "  ERROR: " + (e.shortMessage ?? e.message).split("\n")[0]);
  }
  await sleep(400);
}
