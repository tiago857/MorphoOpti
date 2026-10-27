// Read-only QA of the vault legs against live chain state.
//
// The market legs are already exercised by dryrun.mjs. Vault legs are harder to prove, because
// exiting one needs an ERC-20 allowance a stranger will not have. So this checks two things:
//
//   1. DEPOSIT path: build a real market -> vault bundle for a supplier who has authorised the
//      adapter, and eth_estimateGas it. This needs no approval, so it must simply succeed.
//   2. REDEEM path: build a real vault -> market bundle for an actual vault holder and eth_call it.
//      Without an approval it must revert — but *which* revert is the point. A correctly encoded
//      redeem gets as far as pulling shares and fails on the allowance. A mis-encoded one (owner and
//      receiver swapped) fails earlier and differently, which is exactly the bug this catches.
//
// Nothing is signed or sent.

import { createPublicClient, decodeErrorResult, encodeFunctionData, http, parseAbi, toFunctionSelector } from "viem";
import { base } from "viem/chains";

const RPC = "https://base-rpc.publicnode.com";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const BUNDLER3 = "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4";
const ADAPTER = "0xb98c948CFA24072e58935BC004a8A7b376AE746A";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX = 2n ** 256n - 1n;
const ZERO32 = `0x${"0".repeat(64)}`;
const RAY = 10n ** 27n;

const adapterAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function morphoSupply(MarketParams marketParams, uint256 assets, uint256 shares, uint256 maxSharePriceE27, address onBehalf, bytes data)",
  "function morphoWithdraw(MarketParams marketParams, uint256 assets, uint256 shares, uint256 minSharePriceE27, address receiver)",
  "function erc20Transfer(address token, address receiver, uint256 amount)",
  "function erc4626Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, address receiver)",
  "function erc4626Withdraw(address vault, uint256 assets, uint256 minSharePriceE27, address receiver, address owner)",
  "function erc4626Redeem(address vault, uint256 shares, uint256 minSharePriceE27, address receiver, address owner)",
]);
const bundlerAbi = parseAbi([
  "struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }",
  "function multicall(Call[] bundle) payable",
]);
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32 id, address user) view returns (uint256,uint128,uint128)",
  "function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)",
  "function isAuthorized(address,address) view returns (bool)",
]);
const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function asset() view returns (address)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);

// Every custom error the adapter and the ERC-20 path can raise, so a revert can be named.
const errorAbi = parseAbi([
  "error SlippageExceeded()",
  "error UnexpectedOwner()",
  "error ZeroShares()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error AdapterAddress()",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  // MetaMorpho: the vault cannot service this size right now, regardless of how the call is encoded.
  "error NotEnoughLiquidity()",
]);

const client = createPublicClient({ chain: base, transport: http(RPC, { batch: { wait: 50 }, retryCount: 3 }) });
const call = (data) => ({ to: ADAPTER, data, value: 0n, skipRevert: false, callbackHash: ZERO32 });
const sharePrice = (a, s) => ((a + 1n) * RAY) / (s + 1000000n);
const vaultPrice = (a, s) => ((a + 1n) * RAY) / (s + 1n);

async function gql(query, variables = {}) {
  const r = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

function describeRevert(err) {
  // Walk the error chain for raw revert data and name it.
  let e = err;
  const seen = [];
  while (e) {
    if (e.data && typeof e.data === "string" && e.data.startsWith("0x") && e.data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: errorAbi, data: e.data });
        return `${d.errorName}(${(d.args ?? []).join(", ")})`;
      } catch {
        seen.push(e.data.slice(0, 10));
      }
    }
    e = e.cause;
  }
  const m = /0x[0-9a-f]{8}/i.exec(err.message ?? "");
  if (m) seen.push(m[0]);
  return seen.length ? `unknown selector ${seen.join(" / ")}` : (err.shortMessage ?? err.message ?? "unknown").slice(0, 140);
}

// ---------------------------------------------------------------- pick a vault
const vaultsData = await gql(
  `query { vaults(first: 100, where: { chainId_in: [8453], listed: true }) { items {
     address name asset { address } state { totalAssetsUsd } } } }`,
);
const vault = vaultsData.vaults.items
  .filter((v) => v.asset.address.toLowerCase() === USDC.toLowerCase())
  .sort((a, b) => (b.state?.totalAssetsUsd ?? 0) - (a.state?.totalAssetsUsd ?? 0))[0];
console.log(`vault: ${vault.name} ${vault.address}`);

const [vTotalAssets, vTotalShares] = await Promise.all([
  client.readContract({ address: vault.address, abi: vaultAbi, functionName: "totalAssets" }),
  client.readContract({ address: vault.address, abi: vaultAbi, functionName: "totalSupply" }),
]);
const vPrice = vaultPrice(vTotalAssets, vTotalShares);
console.log(`vault price: ${(Number(vPrice) / 1e27).toFixed(6)} assets/share\n`);

// ---------------------------------------------------- 1. DEPOSIT path, live gas estimate
const marketsData = await gql(
  `query { markets(first: 8, orderBy: SupplyAssetsUsd, orderDirection: Desc,
     where: { chainId_in: [8453], loanAssetAddress_in: ["${USDC.toLowerCase()}"], listed: true })
     { items { marketId collateralAsset { symbol } } } }`,
);
const marketIds = marketsData.markets.items.filter((m) => m.collateralAsset).map((m) => m.marketId);

// Find a supplier who has already authorised the adapter, from recent Morpho supply activity.
const suppliers = await gql(
  `query { marketPositions(first: 100, orderBy: SupplyShares, orderDirection: Desc,
     where: { chainId_in: [8453], marketUniqueKey_in: ${JSON.stringify(marketIds)} })
     { items { user { address } market { marketId } state { supplyAssets } } } }`,
);
let donor = null;
for (const p of suppliers.marketPositions.items) {
  const user = p.user.address;
  const ok = await client.readContract({
    address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [user, ADAPTER],
  });
  if (ok && BigInt(p.state?.supplyAssets ?? "0") > 1_000_000n) {
    donor = { user, marketId: p.market.marketId, assets: BigInt(p.state.supplyAssets) };
    break;
  }
}

if (!donor) {
  console.log("1. DEPOSIT: no authorised supplier found on Base right now; skipping live estimate.");
} else {
  const [m, mp] = await Promise.all([
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [donor.marketId] }),
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [donor.marketId] }),
  ]);
  const params = { loanToken: mp[0], collateralToken: mp[1], oracle: mp[2], irm: mp[3], lltv: mp[4] };
  const move = donor.assets / 10n; // move 10% of their position into the vault
  const mPrice = sharePrice(m[0], m[1]);

  const calls = [
    call(encodeFunctionData({
      abi: adapterAbi, functionName: "morphoWithdraw",
      args: [params, move, 0n, (mPrice * 9990n) / 10000n, ADAPTER],
    })),
    call(encodeFunctionData({
      abi: adapterAbi, functionName: "erc4626Deposit",
      args: [vault.address, MAX, (vPrice * 10010n) / 10000n, donor.user],
    })),
    { ...call(encodeFunctionData({
      abi: adapterAbi, functionName: "erc20Transfer", args: [USDC, donor.user, MAX],
    })), skipRevert: true },
  ];

  console.log(`1. DEPOSIT path — ${donor.user} moving ${(Number(move) / 1e6).toFixed(2)} USDC market -> vault`);
  try {
    const gas = await client.estimateContractGas({
      address: BUNDLER3, abi: bundlerAbi, functionName: "multicall", args: [calls], account: donor.user,
    });
    console.log(`   PASS  eth_estimateGas ok: ${gas.toLocaleString()} gas\n`);
  } catch (err) {
    console.log(`   FAIL  ${describeRevert(err)}\n`);
  }
}

// ---------------------------------------------------- 2. REDEEM path, revert-reason check
// Largest holders of this vault, straight from the API — cheaper and more reliable than log scans.
const holders = await gql(
  `query($v: String!) { vaultPositions(first: 20, orderBy: Shares, orderDirection: Desc,
     where: { chainId_in: [8453], vaultAddress_in: [$v] }) { items { user { address } state { shares } } } }`,
  { v: vault.address.toLowerCase() },
);
let holder = null;
for (const p of holders.vaultPositions.items) {
  const owner = p.user.address;
  const bal = await client.readContract({ address: vault.address, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
  if (bal > 0n) {
    holder = { owner, shares: bal };
    break;
  }
}

if (!holder) {
  console.log("2. REDEEM: no vault holder found in the scanned range; skipping.");
} else {
  const allowance = await client.readContract({
    address: vault.address, abi: vaultAbi, functionName: "allowance", args: [holder.owner, ADAPTER],
  });
  console.log(`2. REDEEM path — holder ${holder.owner}`);
  console.log(`   shares ${holder.shares}, allowance to adapter ${allowance}`);

  // Redeem a small slice, not the whole position: a whale exiting entirely trips the vault's own
  // NotEnoughLiquidity long before the allowance is ever consulted, which tells us nothing about
  // the encoding.
  const maxW = await client.readContract({
    address: vault.address, abi: vaultAbi, functionName: "maxWithdraw", args: [holder.owner],
  });
  const ownAssets = await client.readContract({
    address: vault.address, abi: vaultAbi, functionName: "convertToAssets", args: [holder.shares],
  });
  console.log(
    `   position ${(Number(ownAssets) / 1e6).toFixed(2)} USDC, of which maxWithdraw allows ` +
      `${(Number(maxW) / 1e6).toFixed(2)} right now`,
  );
  const slice = holder.shares / 1000n;

  const redeemData = encodeFunctionData({
    abi: adapterAbi, functionName: "erc4626Redeem",
    args: [vault.address, slice, (vPrice * 9990n) / 10000n, ADAPTER, holder.owner],
  });
  try {
    await client.estimateContractGas({
      address: BUNDLER3, abi: bundlerAbi, functionName: "multicall",
      args: [[call(redeemData)]], account: holder.owner,
    });
    console.log("   ok: redeem simulated without reverting (holder had already approved)\n");
  } catch (err) {
    const reason = describeRevert(err);
    const good = /InsufficientAllowance|allowance|ERC20/i.test(reason);
    const bad = /UnexpectedOwner|ZeroShares/i.test(reason);
    console.log(`   revert: ${reason}`);
    console.log(
      good
        ? "   PASS  reached the share transfer and failed only on the missing allowance — owner/receiver are the right way round."
        : bad
          ? "   FAIL  failed before touching the shares; owner/receiver are encoded the wrong way round."
          : "   ?     unexpected revert, inspect manually.",
    );
  }

  // The inverted encoding, shown failing differently, so the check above means something.
  const invertedData = encodeFunctionData({
    abi: adapterAbi, functionName: "erc4626Redeem",
    args: [vault.address, slice, (vPrice * 9990n) / 10000n, holder.owner, ADAPTER],
  });
  try {
    await client.estimateContractGas({
      address: BUNDLER3, abi: bundlerAbi, functionName: "multicall",
      args: [[call(invertedData)]], account: holder.owner,
    });
    console.log("   control: inverted encoding did NOT revert (unexpected)");
  } catch (err) {
    console.log(`   control: inverted (receiver/owner swapped) reverts with ${describeRevert(err)}`);
  }
}
