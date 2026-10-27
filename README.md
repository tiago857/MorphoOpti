# MorphoOpti

A personal allocator for Morpho Blue — **USDC, USDT and aUSD**, across both raw markets and vaults.
You whitelist the venues you trust, it computes the yield-maximising allocation under a per-venue
exposure cap, and one click rebalances each pool in a **single atomic transaction** signed with your
Fordefi wallet.

Runs entirely in the browser. No backend, no API keys, no custody.

## What it does

1. Lists every listed USDC, USDT and aUSD market **and vault** across Ethereum, Base, Arbitrum,
   HyperEVM and Monad from the Morpho API, in one filterable, sortable table.
2. You pick a whitelist (defaults to the 10 largest per chain, editable, saved in the browser) and
   optionally set a per-market cap and locked amount.
3. Reads authoritative market and position state on-chain and accrues interest to the latest block.
4. Splits your positions into one pool per (chain, loan asset), optimises each independently, and
   shows current vs. target side by side.
5. Builds one `Bundler3.multicall` per pool that withdraws and redeems from over-allocated venues,
   supplies and deposits into under-allocated ones, and sends it to Fordefi for approval.

## Pools

A Bundler3 bundle moves value by withdrawing into an adapter and supplying back out, which can only
happen **within a single loan asset** — crossing assets would need a swap, slippage tolerance and
ERC-20 approvals. So the portfolio is split into independent pools, one per (chain, loan asset):

| | Ethereum | Base | Arbitrum | HyperEVM | Monad |
|---|---|---|---|---|---|
| USDC | ✓ | ✓ | ✓ | ✓ | ✓ |
| USDT | ✓ | — | ✓ (USDT0) | — | — |
| aUSD | ✓ | — | — | — | ✓ |

Each pool has its own optimisation, its own cap arithmetic and its own rebalance button. USDC, USDT
and aUSD never mix. The bundle builder refuses a leg whose loan token differs from its pool.

## Filtering

The market list spans every chain and all three assets, so it filters the way Morpho's own browser
does: by chain, loan asset, LLTV, minimum size and minimum liquidity, plus free-text search over
collateral, loan symbol and market id. Filters are conjunctive; an empty selection in a group means
"no restriction".

Every column sorts. **Total** is supply APY plus rewards — the yield actually earned — and sorting by
it is the fastest way to see where capital should go. Sorting by yield surfaces dust markets printing
four-figure APYs on a few dollars of supply, which is what the minimum-size filter is for.

## Vaults

Morpho vaults (ERC-4626) sit in the same list as raw markets and take part in the same allocation. A
vault joins the pool of its underlying asset, because that is the only pool it can exchange value
with.

Their yield is quoted the way a depositor actually experiences it:

```
APY   = gross yield x (1 - vault fee)      <- what the vault earns, less its cut
Total = APY + incentives                   <- the fee does not apply to incentives,
                                              which a third party pays depositors directly
```

This makes the **Total** column comparable across both venue kinds: a market's supply APY plus
rewards, or a vault's after-fee yield plus incentives. Against the Morpho API's own `netApy` this
formula agrees on 44 of the 46 stablecoin vaults listed across the five chains.

A vault has no interest-rate curve to simulate — it reallocates internally — so the optimiser treats
its rate as **flat** at any size, rather than modelling how your own deposit moves it. Vault
incentives are still diluted by your deposit, since that budget is fixed.

### The approval vaults require

Moving *into* a vault is free: the adapter already holds the assets after a market withdrawal, so it
just deposits. Moving *out* is not — redeeming pulls your vault **shares**, so `GeneralAdapter1`
needs an ERC-20 allowance on that vault's share token. This is the only place the app asks for a
token approval, it is requested per vault and **for exactly the shares that bundle redeems**, and the
Rebalance button stays disabled until it is in place. A bundle that only moves into vaults never asks
for anything.

## The allocation model

Yield is modelled marginally, not as a static ranking. For each market the optimiser simulates how
your own deposit changes utilisation, and therefore the rate, using the Adaptive Curve IRM:

```
u    = totalBorrow / totalSupply
err  = (u - 0.9) / 0.1    if u > 0.9,  else (u - 0.9) / 0.9
rate = rateAtTarget * (1 + 3*err)   if err >= 0,  else rateAtTarget * (1 + 0.75*err)
supplyAPY = (exp(rate * 1yr) - 1) * u * (1 - fee)
```

Capital is then water-filled so that the *marginal* yield is equalised across markets, which
naturally spreads size out of markets too small to absorb it. Reward APRs from the Morpho API are
included and diluted by your own deposit, since the reward budget is fixed.

Constraints applied:

- **Per-market cap**, 10% of the pool by default and adjustable. With fewer than 10 whitelisted
  markets the cap rises evenly to 1/N so the pool can still be fully deployed. Any market can
  override the default with its own cap, which also overrides the 1/N adjustment.
- **Locked capital**: mark the amount in a market that is tied up in a Morpho loop. The optimiser
  never withdraws below it. If a locked amount exceeds that market's cap, the lock wins — the market
  is held above cap and a warning is shown, rather than the app emitting a withdrawal that would
  break the loop.
- **Liquidity floor**: a market can never give back more than its available liquidity.
- **Non-whitelisted** markets you hold are exited to zero.
- **Unmodellable markets** (anything not on the Adaptive Curve IRM) are held in place rather than
  assumed to earn nothing.

Idle balances in your wallet are deliberately *not* part of the portfolio. Only capital already
inside Morpho is reshuffled, so the rebalance needs no approval of the loan token itself. The one
exception is exiting a vault, which pulls your vault shares — see **Vaults** above.

## The rebalance transaction

One call to Morpho's `Bundler3.multicall` **per pool**, built from `GeneralAdapter1` actions in this
order:

1. `morphoWithdraw` from each over-allocated market, with the adapter as receiver. A full exit uses
   `shares = type(uint256).max` so no dust is left behind.
2. `erc4626Redeem` / `erc4626Withdraw` from each over-allocated vault. A full exit redeems the exact
   share balance; a partial one withdraws an exact asset amount.
3. `morphoSupply` into each under-allocated market, and `erc4626Deposit` into each under-allocated
   vault, on behalf of you. The last leg uses `assets = type(uint256).max` to absorb rounding dust.
4. `erc20Transfer` of any leftover loan token back to you, as a safety skim.

Share-price bounds (`minSharePriceE27` / `maxSharePriceE27`) are set 0.1% either side of the accrued
price, so a leg reverts rather than executing at a materially different exchange rate than quoted.
No swap happens anywhere in this bundle. The bundle is gas-estimated before the button enables, so
one that would revert can never be sent.

**One-time setup**: `Morpho.setAuthorization(GeneralAdapter1, true)`, once per chain — one
authorization covers every pool on that chain. The adapter is Morpho's own bundler contract; it can
only act for the account that initiates the bundle and holds no funds between transactions. Beyond
this, the app asks for nothing except a per-vault share approval when a bundle exits a vault.

Fordefi does not implement EIP-5792 wallet batching, which is exactly why batching happens at the
contract level here.

## Running it

Requires Node 18+.

```
npm install
npm run dev
```

Then open http://localhost:5173 and connect Fordefi. The extension is discovered over EIP-6963. If
it does not appear, unlock it, or enable MetaMask emulation in its settings and reload.

Expect `Rebalance` to sit in "Approve in Fordefi" for a while: the transaction must clear your
policy engine and be signed via your mobile device before a hash exists.

### Optional configuration

Copy `.env.example` to `.env` to use dedicated RPC endpoints:

```
VITE_RPC_MAINNET=
VITE_RPC_BASE=
VITE_RPC_ARBITRUM=
VITE_RPC_HYPEREVM=
VITE_RPC_MONAD=
```

Without these the app falls back to public endpoints that were checked against this app's batched
read pattern by `scripts/probe-chains.mjs`. They work but are rate-limited.

### Read-only preview

`?address=0x…` renders the allocation for any address without connecting a wallet. Useful for
sanity-checking before you commit. Rebalancing stays disabled.

## Verification

```
npm test          # 101 unit tests: IRM, shares, accrual, optimizer, pools, vaults, filters, sort, bundle
npm run typecheck
node scripts/verify.mjs    # live: contract wiring + computed APY vs the Morpho API, all five chains
node scripts/probe-chains.mjs  # live: which public RPCs serve this app's batched reads
node scripts/dryrun.mjs 143    # live: build a real bundle and eth_estimateGas it (read-only)
node scripts/qa-vault-bundle.mjs  # live: prove the vault deposit and redeem legs encode correctly
```

`verify.mjs` confirms `GeneralAdapter1.MORPHO()` and `.BUNDLER3()` point at the expected contracts on
each chain, that every loan-asset token exists there, and that computed supply APY matches the Morpho
API. Last run checked 101 markets across all five chains and agreed within 0.06 percentage points on
every market with real size, all on the Adaptive Curve IRM. The only outliers were two dust markets
($2 and $482 supplied) pinned at 93–100% utilisation, where the API's cached APY lags the chain.

`qa-vault-bundle.mjs` covers what dryrun cannot. It gas-estimates a real market → vault bundle, which
needs no approval and so must simply succeed, then encodes a real vault exit and checks *which* way it
reverts. Correctly encoded it reaches the share transfer and fails only on the missing allowance
(`ERC20InsufficientAllowance`); with `receiver` and `owner` swapped it fails earlier, on the adapter's
own empty balance (`ERC20InsufficientBalance`). Those two arguments are adjacent addresses, so the
swapped version shares a function selector with the correct one — nothing but a live call tells them
apart.

`dryrun.mjs [chainId] [loanToken]` finds a real supplier who has already authorised the adapter, runs
the full optimiser, accrues each market to the latest block, encodes the bundle and gas-estimates it
against live chain state. Nothing is signed or sent. Last run passed on all five chains: Ethereum
949k gas, Base 885k, Arbitrum 933k, HyperEVM 807k, Monad 383k.

Accruing before quoting matters. `GeneralAdapter1` bounds each leg by a share price, and on a chain
where a market has gone a while without an on-chain update, the real price has already moved past a
bound quoted from stale state, so the bundle reverts with Morpho's `SlippageExceeded()`. Despite the
name that is a share-price guard, not trading slippage — this app never swaps.

## Addresses

**Morpho Blue is not at the same address on every chain** — Arbitrum, HyperEVM and Monad each have
their own deployment. Everything below is asserted live by `scripts/verify.mjs`.

| | Ethereum (1) | Base (8453) | Arbitrum (42161) | HyperEVM (999) | Monad (143) |
|---|---|---|---|---|---|
| Morpho Blue | `0xBBBB…FFCb` | `0xBBBB…FFCb` | `0x6c24…8F5e` | `0x68e3…57cD` | `0xD5D9…eAee` |
| Bundler3 | `0x6566…Fa0245` | `0x6BFd…20C4` | `0x1FA4…8C13` | `0xa3F5…Fa0e` | `0x82b6…c66E` |
| GeneralAdapter1 | `0x4A6c…0aE0` | `0xb98c…46aA` | `0x9954…8B88` | `0xD7F4…4aE4` | `0x725A…00e5` |
| Adaptive Curve IRM | `0x870a…Ba00BC` | `0x4641…2687` | `0x66F3…06DA` | `0xD4a4…7483` | `0x0947…400F` |
| USDC | `0xA0b8…eB48` | `0x8335…2913` | `0xaf88…5831` | `0xb883…630f` | `0x7547…b603` |
| USDT | `0xdAC1…1ec7` | — | `0xFd08…Cbb9` (USDT0) | — | — |
| aUSD | `0x0000…012a` | — | — | — | `0x0000…012a` |

Full values live in `src/config/chains.ts`; they were taken from Morpho's own address registry
(`@morpho-org/morpho-ts`) and cross-checked against the API's deployment data.

On Arbitrum the listed Tether market is **USDT0**, Tether's omnichain USDT — plain USDT has no listed
Morpho markets there. aUSD is Agora's dollar, at the same address on Ethereum and Monad.

## Layout

```
src/core/       pure logic, fully unit-tested: math, irm, accrue, optimizer, pools, vault, filters, sort, bundle
src/data/       Morpho GraphQL client and on-chain multicall reads
src/hooks/      whitelist + cap/locked persistence, data fetching, rebalance state machine
src/components/ UI
scripts/        live read-only verification tools
```

`core/pools.ts` holds the (chain, loan asset) split and is what keeps loan assets from mixing;
`core/filters.ts` holds the market-list filtering. Both are pure and tested offline.

`src/core` takes bigints in and gives bigints out, with no React or network dependency, so the
allocation and encoding logic can be tested exhaustively offline.

## Limits

- The optimiser maximises modelled yield under a size cap. It does not model collateral risk,
  oracle risk, or curator quality. That is what your whitelist is for.
- Pools are optimised independently. The app will not tell you that USDT pays more than USDC today,
  because it cannot act on that without a swap.
- A vault's rate is taken flat from the API. The optimiser does not model how a large deposit would
  change what the vault's own underlying markets pay, so a big allocation into one is an estimate.
- Locked amounts are a number you type, not something read from chain. The app trusts it.
- Rates move between the quote and the transaction being mined. The share-price bounds protect
  against adverse movement by reverting, not by re-quoting.
- Reward APRs come from the Morpho API and are not claimed by this app.
