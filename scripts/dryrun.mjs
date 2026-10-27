// End-to-end read-only dry run: find a real Morpho USDC supplier who has already authorized
// GeneralAdapter1, run the optimizer on their live position, encode the Bundler3 bundle, and
// eth_estimateGas it as them. Nothing is signed or sent.
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { arbitrum, base, hyperEvm, mainnet, monad } from "viem/chains";

// Usage: node scripts/dryrun.mjs [chainId] [loanTokenAddress]
// The loan token defaults to that chain's USDC; pass another to dry-run a USDT or aUSD pool.
const CHAIN_ID = Number(process.argv[2] ?? 8453);
const ALL = {
  1: {
    chain: mainnet,
    rpc: "https://ethereum-rpc.publicnode.com",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
    adapter: "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0",
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  8453: {
    chain: base,
    rpc: "https://base-rpc.publicnode.com",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
    adapter: "0xb98c948CFA24072e58935BC004a8A7b376AE746A",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  42161: {
    chain: arbitrum,
    rpc: "https://arbitrum-one-rpc.publicnode.com",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    bundler3: "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13",
    adapter: "0x9954aFB60BB5A222714c478ac86990F221788B88",
    irm: "0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  999: {
    chain: hyperEvm,
    rpc: "https://rpc.hyperliquid.xyz/evm",
    morpho: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
    bundler3: "0xa3F50477AfA601C771874260A3B34B40e244Fa0e",
    adapter: "0xD7F48aDE56613E8605863832B7B8A1985B934aE4",
    irm: "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483",
    usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  },
  143: {
    chain: monad,
    rpc: "https://rpc.monad.xyz",
    morpho: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
    bundler3: "0x82b684483e844422FD339df0b67b3B111F02c66E",
    adapter: "0x725AB8CAd931BCb80Fdbf10955a806765cCe00e5",
    irm: "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
};
const CFG = ALL[CHAIN_ID];
if (!CFG) {
  console.error(`Unknown chain ${CHAIN_ID}. Supported: ${Object.keys(ALL).join(", ")}`);
  process.exit(1);
}
// A dry run targets one pool, so the loan token is fixed for the whole run.
CFG.usdc = process.argv[3] ?? CFG.usdc;
const MORPHO = CFG.morpho;
const MAX = 2n ** 256n - 1n;
const ZERO32 = `0x${"0".repeat(64)}`;

const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32 id, address user) view returns (uint256,uint128,uint128)",
  "function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)",
  "function isAuthorized(address,address) view returns (bool)",
]);
const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function rateAtTarget(bytes32 id) view returns (int256)",
  "function borrowRateView(MarketParams, Market) view returns (uint256)",
]);
const adapterAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function morphoSupply(MarketParams marketParams, uint256 assets, uint256 shares, uint256 maxSharePriceE27, address onBehalf, bytes data)",
  "function morphoWithdraw(MarketParams marketParams, uint256 assets, uint256 shares, uint256 minSharePriceE27, address receiver)",
  "function erc20Transfer(address token, address receiver, uint256 amount)",
]);
const bundlerAbi = parseAbi([
  "struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }",
  "function multicall(Call[] bundle) payable",
]);

const client = createPublicClient({ chain: CFG.chain, transport: http(CFG.rpc, { retryCount: 5, batch: true }) });

async function gql(query) {
  const r = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

// 1. Listed USDC markets.
const mk = await gql(
  `query { markets(first: 12, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [${CHAIN_ID}], loanAssetAddress_in: ["${CFG.usdc.toLowerCase()}"], listed: true }) { items { marketId collateralAsset { symbol } state { rewards { supplyApr } } } } }`,
);
const listed = mk.markets.items.filter((m) => m.collateralAsset);
const ids = listed.map((m) => m.marketId);
console.log(`listed USDC markets on chain ${CHAIN_ID}: ${ids.length}`);

// 2. Candidate suppliers across those markets.
const pos = await gql(
  `query { marketPositions(first: 100, orderBy: SupplyShares, orderDirection: Desc, where: { chainId_in: [${CHAIN_ID}], marketUniqueKey_in: [${ids.map((i) => `"${i}"`).join(",")}], supplyShares_gte: "1000000000000" }) { items { user { address } market { marketId } } } }`,
);
const candidates = [...new Set(pos.marketPositions.items.map((p) => p.user.address))];
console.log(`candidate suppliers: ${candidates.length}`);

// 3. Who already authorized GeneralAdapter1?
const auths = await client.multicall({
  allowFailure: false,
  contracts: candidates.map((u) => ({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [u, CFG.adapter] })),
});
const authorized = candidates.filter((_, i) => auths[i]);
console.log(`already authorized the adapter: ${authorized.length}`);
if (!authorized.length) {
  console.log("No authorized supplier found; cannot gas-estimate a real bundle.");
  process.exit(0);
}

// 4. Pick the one with the most USDC spread over the most markets.
let best = null;
for (const user of authorized.slice(0, 12)) {
  const reads = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] },
      { address: MORPHO, abi: morphoAbi, functionName: "position", args: [id, user] },
      { address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] },
      { address: CFG.irm, abi: irmAbi, functionName: "rateAtTarget", args: [id] },
    ]),
  });
  const markets = ids.map((id, k) => {
    const m = reads[k * 4];
    const p = reads[k * 4 + 1];
    const mp = reads[k * 4 + 2];
    const rT = reads[k * 4 + 3];
    const totalSupplyAssets = m[0];
    const totalSupplyShares = m[1];
    const assets = totalSupplyShares + 1000000n === 0n ? 0n : (p[0] * (totalSupplyAssets + 1n)) / (totalSupplyShares + 1000000n);
    return {
      id,
      symbol: listed[k].collateralAsset.symbol,
      params: { loanToken: mp[0], collateralToken: mp[1], oracle: mp[2], irm: mp[3], lltv: mp[4] },
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets: m[2],
      totalBorrowShares: m[3],
      lastUpdate: m[4],
      fee: m[5],
      rateAtTarget: rT < 0n ? 0n : rT,
      rewardApr: (listed[k].state?.rewards ?? []).reduce((a, r) => a + (r.supplyApr ?? 0), 0),
      position: assets,
    };
  });
  const total = markets.reduce((a, m) => a + m.position, 0n);
  const n = markets.filter((m) => m.position > 1000000n).length;
  if (total > 10n * 1000000n && (!best || n > best.n || (n === best.n && total > best.total))) {
    best = { user, markets, total, n };
  }
}
if (!best) {
  console.log("No authorized supplier with a USDC position in the listed markets.");
  process.exit(0);
}
console.log(`\nusing ${best.user}: ${(Number(best.total) / 1e6).toLocaleString()} USDC across ${best.n} markets`);

// 5. Optimize (mirrors src/core/optimizer.ts).
const SPY = 31536000;
const curve = (u) => {
  const e = u > 0.9 ? (u - 0.9) / 0.1 : (u - 0.9) / 0.9;
  return e >= 0 ? 1 + 3 * e : 1 + 0.75 * e;
};
const supplyApy = (u, rT, fee) => (Math.exp(rT * curve(u) * SPY) - 1) * u * (1 - fee);
const T = Number(best.total);
const N = best.markets.length;
const capF = Math.max(0.1, 1 / N);
const work = best.markets.map((m) => {
  const S = Number(m.totalSupplyAssets);
  const B = Number(m.totalBorrowAssets);
  const p = Number(m.position);
  return {
    m,
    sExt: Math.max(0, S - p),
    b: B,
    fee: Number(m.fee) / 1e18,
    rT: Number(m.rateAtTarget) / 1e18,
    budget: m.rewardApr * S,
    pos: p,
    cap: capF * T,
    floor: Math.max(0, p - Math.max(0, S - B)),
    x: Math.max(0, p - Math.max(0, S - B)),
  };
});
const yieldAt = (w, x) => {
  if (x <= 0) return 0;
  const t = w.sExt + x;
  return x * supplyApy(Math.min(w.b / t, 1), w.rT, w.fee) + w.budget * (x / t);
};
let rem = T - work.reduce((a, w) => a + w.floor, 0);
const step = Math.max(Math.floor(rem / 2000), 1);
while (rem >= 1) {
  const room = Math.max(0, ...work.map((w) => Math.floor(w.cap - w.x)));
  if (room < 1) break;
  const d = Math.max(1, Math.min(step, Math.floor(rem), room));
  let bi = -1, bg = -Infinity;
  work.forEach((w, i) => {
    if (w.x + d > w.cap + 1e-6) return;
    const g = yieldAt(w, w.x + d) - yieldAt(w, w.x);
    if (g > bg) { bg = g; bi = i; }
  });
  if (bi < 0) break;
  work[bi].x += d;
  rem -= d;
}
const targets = work.map((w) => BigInt(Math.round(w.x)));
let diff = best.total - BigInt(Math.round(rem)) - targets.reduce((a, b) => a + b, 0n);
if (diff !== 0n) {
  let bi = 0;
  targets.forEach((t, i) => { if (t > targets[bi]) bi = i; });
  targets[bi] += diff;
}
const DUST = 1000000n;
const legs = [];
console.log("\n" + "market".padEnd(22) + "current".padStart(14) + "target".padStart(14) + "move".padStart(14));
best.markets.forEach((m, i) => {
  let d = targets[i] - m.position;
  if (d < 0n ? -d < DUST : d < DUST) { targets[i] = m.position; d = 0n; }
  console.log(
    m.symbol.padEnd(22) +
      (Number(m.position) / 1e6).toFixed(2).padStart(14) +
      (Number(targets[i]) / 1e6).toFixed(2).padStart(14) +
      (d === 0n ? "-" : (Number(d) / 1e6).toFixed(2)).padStart(14),
  );
  if (d !== 0n) legs.push({ ...m, target: targets[i], delta: d, current: m.position });
});
if (!legs.length) {
  console.log("\nAlready at target; nothing to encode.");
  process.exit(0);
}

// 6. Accrue each leg's market to the latest block before quoting a share price.
// The app does this (src/data/onchain.ts -> core/accrue.ts); without it the quote is the stale
// last-update price, and on a chain where markets go untouched for a while the real price has
// already moved past the bound, so GeneralAdapter1 reverts with SlippageExceeded().
const WAD = 10n ** 18n;
const wMulDown = (x, y) => (x * y) / WAD;
const wTaylorCompounded = (rate, elapsed) => {
  const x = rate * elapsed;
  const x2 = (x * x) / WAD / 2n;
  const x3 = (x2 * x) / WAD / 3n;
  return x + x2 + x3;
};
const toSharesDown = (assets, totalAssets, totalShares) =>
  (assets * (totalShares + 1000000n)) / (totalAssets + 1n);

const legBlock = await client.getBlock();
const legRates = await client.multicall({
  allowFailure: false,
  contracts: legs.map((l) => ({
    address: CFG.irm,
    abi: irmAbi,
    functionName: "borrowRateView",
    args: [
      l.params,
      {
        totalSupplyAssets: l.totalSupplyAssets,
        totalSupplyShares: l.totalSupplyShares,
        totalBorrowAssets: l.totalBorrowAssets,
        totalBorrowShares: l.totalBorrowShares,
        lastUpdate: l.lastUpdate,
        fee: l.fee,
      },
    ],
  })),
});

legs.forEach((l, i) => {
  const elapsed = legBlock.timestamp - l.lastUpdate;
  if (elapsed <= 0n || l.totalBorrowAssets === 0n || legRates[i] === 0n) return;
  const interest = wMulDown(l.totalBorrowAssets, wTaylorCompounded(legRates[i], elapsed));
  l.totalSupplyAssets += interest;
  if (l.fee > 0n) {
    const feeAmount = wMulDown(interest, l.fee);
    l.totalSupplyShares += toSharesDown(feeAmount, l.totalSupplyAssets - feeAmount, l.totalSupplyShares);
  }
});
console.log(`accrued ${legs.length} legs to block ${legBlock.number} (${legBlock.timestamp})`);

// 7. Encode the bundle (mirrors src/core/bundle.ts).
const RAY = 10n ** 27n;
const sharePrice = (a, s) => ((a + 1n) * RAY) / (s + 1000000n);
const withdraws = legs.filter((l) => l.delta < 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));
const supplies = legs.filter((l) => l.delta > 0n).sort((a, b) => (a.delta < b.delta ? -1 : 1));
const totalW = withdraws.reduce((a, l) => a + (l.target === 0n ? l.current : -l.delta), 0n);
const totalS = supplies.reduce((a, l) => a + l.delta, 0n);
console.log(`\nwithdraw ${(Number(totalW) / 1e6).toFixed(2)} USDC, supply ${(Number(totalS) / 1e6).toFixed(2)} USDC`);
if (totalS > totalW) throw new Error("supply exceeds withdraw");

const calls = [];
for (const l of withdraws) {
  const full = l.target === 0n;
  calls.push({
    to: CFG.adapter,
    data: encodeFunctionData({
      abi: adapterAbi,
      functionName: "morphoWithdraw",
      args: [l.params, full ? 0n : -l.delta, full ? MAX : 0n, (sharePrice(l.totalSupplyAssets, l.totalSupplyShares) * 9990n) / 10000n, CFG.adapter],
    }),
    value: 0n, skipRevert: false, callbackHash: ZERO32,
  });
}
supplies.forEach((l, i) => {
  const last = i === supplies.length - 1;
  calls.push({
    to: CFG.adapter,
    data: encodeFunctionData({
      abi: adapterAbi,
      functionName: "morphoSupply",
      args: [l.params, last ? MAX : l.delta, 0n, (sharePrice(l.totalSupplyAssets, l.totalSupplyShares) * 10010n) / 10000n, best.user, "0x"],
    }),
    value: 0n, skipRevert: false, callbackHash: ZERO32,
  });
});
calls.push({
  to: CFG.adapter,
  data: encodeFunctionData({ abi: adapterAbi, functionName: "erc20Transfer", args: [CFG.usdc, best.user, MAX] }),
  value: 0n, skipRevert: true, callbackHash: ZERO32,
});
console.log(`bundle calls: ${calls.length} (${withdraws.length} withdraw, ${supplies.length} supply, 1 skim)`);

// 7. Real gas estimate as the user. Read-only.
try {
  const gas = await client.estimateContractGas({
    address: CFG.bundler3,
    abi: bundlerAbi,
    functionName: "multicall",
    args: [calls],
    account: best.user,
  });
  console.log(`\nESTIMATEGAS OK: ${gas.toLocaleString()} gas -- the bundle executes successfully on chain state.`);
} catch (e) {
  console.log(`\nESTIMATEGAS FAILED: ${(e.shortMessage ?? e.message).split("\n")[0]}`);
  if (e.metaMessages) console.log(e.metaMessages.slice(0, 6).join("\n"));
}
const data = encodeFunctionData({ abi: bundlerAbi, functionName: "multicall", args: [calls] });
console.log(`calldata: ${data.length / 2 - 1} bytes to Bundler3 ${CFG.bundler3}`);
