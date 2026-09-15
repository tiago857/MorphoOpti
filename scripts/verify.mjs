// Read-only live verification of addresses, API shape, and optimizer inputs.
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base, mainnet } from "viem/chains";

const CHAINS = {
  1: {
    chain: mainnet,
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
    adapter: "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0",
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpc: "https://ethereum-rpc.publicnode.com",
  },
  8453: {
    chain: base,
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
    adapter: "0xb98c948CFA24072e58935BC004a8A7b376AE746A",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpc: "https://base-rpc.publicnode.com",
  },
};

const adapterAbi = parseAbi([
  "function MORPHO() view returns (address)",
  "function BUNDLER3() view returns (address)",
  "function WRAPPED_NATIVE() view returns (address)",
]);
const bundlerAbi = parseAbi(["function initiator() view returns (address)"]);
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)",
  "function isAuthorized(address,address) view returns (bool)",
]);
const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function rateAtTarget(bytes32 id) view returns (int256)",
  "function borrowRateView(MarketParams, Market) view returns (uint256)",
]);

async function gql(query, variables) {
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

const MARKET_FIELDS = `
  marketId lltv irmAddress listed
  loanAsset { address symbol decimals }
  collateralAsset { address symbol decimals }
  state { supplyApy netSupplyApy utilization supplyAssets borrowAssets supplyAssetsUsd liquidityAssets fee rateAtTarget rewards { asset { address symbol } supplyApr } }
`;

const SECONDS_PER_YEAR = 31536000;
const curve = (u) => {
  const err = u > 0.9 ? (u - 0.9) / 0.1 : (u - 0.9) / 0.9;
  return err >= 0 ? 1 + 3 * err : 1 + 0.75 * err;
};
const supplyApy = (u, rT, fee) => (Math.exp(rT * curve(u) * SECONDS_PER_YEAR) - 1) * u * (1 - fee);

for (const [id, cfg] of Object.entries(CHAINS)) {
  console.log(`\n${"=".repeat(70)}\n${cfg.chain.name} (${id})\n${"=".repeat(70)}`);
  // Public RPCs rate-limit aggressively; retry generously so this script is a real check, not a flake.
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(process.env[id === "1" ? "RPC_MAINNET" : "RPC_BASE"] || cfg.rpc, {
      retryCount: 8,
      retryDelay: 1500,
      batch: { wait: 50 },
    }),
  });

  // 1. Contracts exist and wire up to each other.
  for (const [name, addr] of [["Morpho", cfg.morpho], ["Bundler3", cfg.bundler3], ["GeneralAdapter1", cfg.adapter], ["IRM", cfg.irm], ["USDC", cfg.usdc]]) {
    const code = await client.getCode({ address: addr });
    console.log(`${name.padEnd(16)} ${addr} code=${code && code !== "0x" ? `${code.length / 2 - 1}B` : "NONE !!!"}`);
  }

  try {
    const [m, b] = await Promise.all([
      client.readContract({ address: cfg.adapter, abi: adapterAbi, functionName: "MORPHO" }),
      client.readContract({ address: cfg.adapter, abi: adapterAbi, functionName: "BUNDLER3" }),
    ]);
    console.log(`adapter.MORPHO()   = ${m}  ${getAddress(m) === getAddress(cfg.morpho) ? "OK" : "MISMATCH !!!"}`);
    console.log(`adapter.BUNDLER3() = ${b}  ${getAddress(b) === getAddress(cfg.bundler3) ? "OK" : "MISMATCH !!!"}`);
  } catch (e) {
    console.log("adapter wiring check failed:", e.shortMessage ?? e.message);
  }
  try {
    const init = await client.readContract({ address: cfg.bundler3, abi: bundlerAbi, functionName: "initiator" });
    console.log(`bundler3.initiator() = ${init} (zero outside a bundle: OK)`);
  } catch (e) {
    console.log("bundler3.initiator() failed:", e.shortMessage ?? e.message);
  }

  // 2. Listing + cross-check API vs on-chain for the top markets.
  const data = await gql(
    `query($chainId: Int!, $usdc: String!) { markets(first: 12, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [$chainId], loanAssetAddress_in: [$usdc], listed: true }) { items { ${MARKET_FIELDS} } } }`,
    { chainId: Number(id), usdc: cfg.usdc.toLowerCase() },
  );
  const items = data.markets.items.filter((m) => m.collateralAsset);
  console.log(`\ntop listed USDC markets: ${items.length}`);

  const ids = items.map((m) => m.marketId);
  const states = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((i) => [
      { address: cfg.morpho, abi: morphoAbi, functionName: "market", args: [i] },
      { address: cfg.morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [i] },
    ]),
  });
  const irmReads = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((i, k) => {
      const mp = states[k * 2 + 1];
      const params = { loanToken: mp[0], collateralToken: mp[1], oracle: mp[2], irm: mp[3], lltv: mp[4] };
      const m = states[k * 2];
      const market = { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] };
      return [
        { address: cfg.irm, abi: irmAbi, functionName: "rateAtTarget", args: [i] },
        { address: cfg.irm, abi: irmAbi, functionName: "borrowRateView", args: [params, market] },
      ];
    }),
  });

  console.log(
    "\n" +
      "collateral".padEnd(12) +
      "supplied".padStart(14) +
      "util".padStart(8) +
      "apiAPY".padStart(9) +
      "calcAPY".padStart(9) +
      "diff".padStart(8) +
      "rewards".padStart(9) +
      "  irm",
  );
  for (let k = 0; k < ids.length; k++) {
    const it = items[k];
    const m = states[k * 2];
    const mp = states[k * 2 + 1];
    const S = Number(m[0]) / 1e6;
    const B = Number(m[2]) / 1e6;
    const u = S > 0 ? B / S : 0;
    const fee = Number(m[5]) / 1e18;
    const rT = Number(irmReads[k * 2]) / 1e18;
    const calc = supplyApy(u, rT, fee);
    const api = it.state?.supplyApy ?? 0;
    const rw = (it.state?.rewards ?? []).reduce((a, r) => a + (r.supplyApr ?? 0), 0);
    const irmOk = getAddress(mp[3]) === getAddress(cfg.irm) ? "adaptive" : mp[3].slice(0, 10);
    console.log(
      it.collateralAsset.symbol.padEnd(12) +
        S.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(14) +
        (u * 100).toFixed(1).padStart(8) +
        (api * 100).toFixed(2).padStart(9) +
        (calc * 100).toFixed(2).padStart(9) +
        ((calc - api) * 100).toFixed(2).padStart(8) +
        (rw > 0 ? (rw * 100).toFixed(2) : "-").padStart(9) +
        "  " +
        irmOk,
    );
  }

  // 4. isAuthorized read against a random address (must not revert).
  const auth = await client.readContract({
    address: cfg.morpho,
    abi: morphoAbi,
    functionName: "isAuthorized",
    args: ["0x000000000000000000000000000000000000dEaD", cfg.adapter],
  });
  console.log(`\nisAuthorized(dead, adapter) = ${auth} (read works)`);
}
