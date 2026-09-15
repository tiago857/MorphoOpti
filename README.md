# MorphoOpti

A personal allocator for Morpho Blue USDC markets. You whitelist markets, it computes the
yield-maximising allocation under a per-market exposure cap, and one click rebalances the whole
portfolio in a **single atomic transaction** signed with your Fordefi wallet.

Runs entirely in the browser. No backend, no API keys, no custody.

## What it does

1. Lists every listed USDC market on Ethereum and Base from the Morpho API.
2. You pick a whitelist (defaults to the 10 largest, editable, saved per chain in the browser).
3. Reads authoritative market and position state on-chain and accrues interest to the latest block.
4. Optimises the allocation, then shows current vs. target side by side.
5. Builds one `Bundler3.multicall` that withdraws from over-allocated markets and supplies to
   under-allocated ones, and sends it to Fordefi for approval.

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

- **Per-market cap** of 10% of the portfolio. With fewer than 10 whitelisted markets the cap rises
  evenly to 1/N so the portfolio can still be fully deployed.
- **Liquidity floor**: a market can never give back more than its available liquidity.
- **Non-whitelisted** markets you hold are exited to zero.
- **Unmodellable markets** (anything not on the Adaptive Curve IRM) are held in place rather than
  assumed to earn nothing.

Idle USDC in your wallet is deliberately *not* part of the portfolio. Only capital already inside
Morpho is reshuffled, so the rebalance needs no token approvals at all.

## The rebalance transaction

One call to Morpho's `Bundler3.multicall`, built from `GeneralAdapter1` actions in this order:

1. `morphoWithdraw` from each over-allocated market, with the adapter as receiver. A full exit uses
   `shares = type(uint256).max` so no dust is left behind.
2. `morphoSupply` into each under-allocated market, on behalf of you. The last supply uses
   `assets = type(uint256).max` to absorb rounding dust.
3. `erc20Transfer` of any leftover USDC back to you, as a safety skim.

Share-price bounds (`minSharePriceE27` / `maxSharePriceE27`) are set 0.1% either side of the accrued
price to bound slippage. The bundle is gas-estimated before the button enables, so a bundle that
would revert can never be sent.

**One-time setup**: `Morpho.setAuthorization(GeneralAdapter1, true)`. The adapter is Morpho's own
bundler contract; it can only act for the account that initiates the bundle and holds no funds
between transactions. The app prompts for this and nothing else.

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
```

Without these the app falls back to public endpoints that were checked against this app's read
pattern. They work but are rate-limited.

### Read-only preview

`?address=0x…` renders the allocation for any address without connecting a wallet. Useful for
sanity-checking before you commit. Rebalancing stays disabled.

## Verification

```
npm test          # 35 unit tests: IRM curve, shares math, accrual, optimizer, bundle encoding
npm run typecheck
node scripts/verify.mjs    # live: contract wiring + computed APY vs the Morpho API, both chains
node scripts/dryrun.mjs 8453   # live: build a real bundle and eth_estimateGas it (read-only)
```

`verify.mjs` confirms `GeneralAdapter1.MORPHO()` and `.BUNDLER3()` point at the expected contracts
and that computed supply APY matches the Morpho API. Last run agreed within 0.04 percentage points
across all 24 markets checked.

`dryrun.mjs` finds a real supplier who has already authorised the adapter, runs the full optimiser,
encodes the bundle and gas-estimates it against live chain state. Nothing is signed or sent.

## Addresses

| Contract | Ethereum | Base |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | same |
| Bundler3 | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` | `0x6BFd8137e702540E7A42B74178A4a49Ba43920C4` |
| GeneralAdapter1 | `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` | `0xb98c948CFA24072e58935BC004a8A7b376AE746A` |
| Adaptive Curve IRM | `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC` | `0x46415998764C29aB2a25CbeA6254146D50D22687` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Layout

```
src/core/       pure logic, fully unit-tested: math, irm, accrue, optimizer, bundle
src/data/       Morpho GraphQL client and on-chain multicall reads
src/hooks/      whitelist persistence, data fetching, rebalance state machine
src/components/ UI
scripts/        live read-only verification tools
```

`src/core` takes bigints in and gives bigints out, with no React or network dependency, so the
allocation and encoding logic can be tested exhaustively offline.

## Limits

- The optimiser maximises modelled yield under a size cap. It does not model collateral risk,
  oracle risk, or curator quality. That is what your whitelist is for.
- Rates move between the quote and the transaction being mined. The share-price bounds protect
  against adverse movement by reverting, not by re-quoting.
- Reward APRs come from the Morpho API and are not claimed by this app.
