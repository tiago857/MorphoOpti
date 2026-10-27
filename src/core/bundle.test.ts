import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { bundler3Abi } from "../abi/bundler3";
import { generalAdapter1Abi } from "../abi/generalAdapter1";
import { buildRebalanceBundle, encodeBundlerMulticall, type MarketLeg, type VaultLeg } from "./bundle";
import { MAX_UINT256 } from "./math";
import type { MarketParams } from "./types";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ADAPTER: Address = "0xb98c948CFA24072e58935BC004a8A7b376AE746A";
const USER: Address = "0x1111111111111111111111111111111111111111";
const chain = { generalAdapter1: ADAPTER };

function params(n: number): MarketParams {
  const addr = `0x${n.toString(16).padStart(40, "0")}` as Address;
  return { loanToken: USDC, collateralToken: addr, oracle: addr, irm: addr, lltv: 860000000000000000n };
}

function leg(n: number, current: bigint, target: bigint): MarketLeg {
  return {
    id: `0x${n.toString(16).padStart(64, "0")}` as Hex,
    params: params(n),
    current,
    target,
    delta: target - current,
    totalSupplyAssets: 1_000_000_000_000n,
    totalSupplyShares: 1_000_000_000_000n * 10n ** 6n,
  };
}

function decode(data: Hex) {
  const d = decodeFunctionData({ abi: generalAdapter1Abi, data });
  return { functionName: d.functionName, args: d.args as readonly unknown[] };
}

describe("buildRebalanceBundle", () => {
  it("orders withdraws before supplies and appends a skim", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 300n, 100n), leg(2, 0n, 150n), leg(3, 100n, 150n), leg(4, 50n, 50n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    expect(bundle.steps.map((s) => s.kind)).toEqual(["withdraw", "supply", "supply", "skim"]);
    expect(bundle.totalWithdraw).toBe(200n);
    expect(bundle.totalSupply).toBe(200n);
    for (const c of bundle.calls) {
      expect(c.to).toBe(ADAPTER);
      expect(c.value).toBe(0n);
    }
  });

  it("encodes a partial withdraw with assets and a slippage floor", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 300n, 100n), leg(2, 0n, 200n)], user: USER, chain, loanToken: USDC });
    const w = decode(bundle.calls[0].data);
    expect(w.functionName).toBe("morphoWithdraw");
    const [, assets, shares, minPrice, receiver] = w.args as [unknown, bigint, bigint, bigint, Address];
    expect(assets).toBe(200n);
    expect(shares).toBe(0n);
    expect(receiver).toBe(ADAPTER);
    // share price ~1e21 (1 USDC per 1e6 shares) minus 0.1%
    expect(minPrice).toBeLessThan(10n ** 21n);
    expect(minPrice).toBeGreaterThan((10n ** 21n * 998n) / 1000n);
  });

  it("uses shares = max for a full exit", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 300n, 0n), leg(2, 0n, 300n)], user: USER, chain, loanToken: USDC });
    const w = decode(bundle.calls[0].data);
    const [, assets, shares] = w.args as [unknown, bigint, bigint];
    expect(assets).toBe(0n);
    expect(shares).toBe(MAX_UINT256);
    expect(bundle.steps[0].fullExit).toBe(true);
  });

  it("sweeps the adapter balance into the largest (last) supply leg", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 500n, 0n), leg(2, 0n, 100n), leg(3, 0n, 400n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const s1 = decode(bundle.calls[1].data);
    const s2 = decode(bundle.calls[2].data);
    expect(s1.functionName).toBe("morphoSupply");
    expect(s1.args[1]).toBe(100n);
    expect(s2.args[1]).toBe(MAX_UINT256);
    expect(s2.args[4]).toBe(USER);
  });

  it("can disable the sweep so leftovers go back to the wallet", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 500n, 0n), leg(2, 0n, 400n)],
      user: USER,
      chain,
      loanToken: USDC,
      sweepIntoLastSupply: false,
    });
    const s = decode(bundle.calls[1].data);
    expect(s.args[1]).toBe(400n);
  });

  it("skim transfers the whole USDC balance to the user with skipRevert", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 10n, 0n), leg(2, 0n, 10n)], user: USER, chain, loanToken: USDC });
    const skim = bundle.calls.at(-1)!;
    expect(skim.skipRevert).toBe(true);
    const d = decode(skim.data);
    expect(d.functionName).toBe("erc20Transfer");
    expect(d.args).toEqual([USDC, USER, MAX_UINT256]);
  });

  it("rejects bundles that supply more than they withdraw", () => {
    expect(() => buildRebalanceBundle({ legs: [leg(1, 100n, 50n), leg(2, 0n, 100n)], user: USER, chain, loanToken: USDC })).toThrow(
      /wallet balances/,
    );
  });

  it("encodes a Bundler3.multicall that round-trips", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 100n, 0n), leg(2, 0n, 100n)], user: USER, chain, loanToken: USDC });
    const data = encodeBundlerMulticall(bundle.calls);
    const decoded = decodeFunctionData({ abi: bundler3Abi, data });
    expect(decoded.functionName).toBe("multicall");
    const calls = decoded.args[0] as readonly { to: Address; data: Hex }[];
    expect(calls).toHaveLength(3);
    expect(calls[0].to).toBe(ADAPTER);
  });
  it("refuses to build a bundle whose legs do not all share the loan token", () => {
    const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const foreign = leg(2, 0n, 100n);
    foreign.params = { ...foreign.params, loanToken: USDT };
    expect(() =>
      buildRebalanceBundle({ legs: [leg(1, 100n, 0n), foreign], user: USER, chain, loanToken: USDC }),
    ).toThrow(/cannot move value across loan assets/);
  });

  it("skims the pool's own loan token, not a hard-coded one", () => {
    const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const usdtLeg = (n: number, current: bigint, target: bigint): MarketLeg => {
      const l = leg(n, current, target);
      l.params = { ...l.params, loanToken: USDT };
      return l;
    };
    const bundle = buildRebalanceBundle({
      legs: [usdtLeg(1, 100n, 0n), usdtLeg(2, 0n, 100n)],
      user: USER,
      chain,
      loanToken: USDT,
    });
    const skim = decode(bundle.calls[bundle.calls.length - 1].data);
    expect(skim.functionName).toBe("erc20Transfer");
    expect(skim.args[0]).toBe(USDT);
  });
});

describe("vault legs", () => {
  const VAULT: Address = "0x2222222222222222222222222222222222222222";
  const RAY = 10n ** 27n;

  function vaultLeg(current: bigint, target: bigint, over: Partial<VaultLeg> = {}): VaultLeg {
    return {
      kind: "vault",
      id: VAULT,
      current,
      target,
      delta: target - current,
      shares: current, // 1:1 for a fresh vault
      totalAssets: 1_000_000n,
      totalShares: 1_000_000n,
      asset: USDC,
      ...over,
    };
  }

  it("deposits into a vault with the adapter's own balance", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 300n, 0n), vaultLeg(0n, 300n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const deposit = decode(bundle.calls[1].data);
    expect(deposit.functionName).toBe("erc4626Deposit");
    expect(deposit.args[0]).toBe(VAULT);
    // Receiver is the user, so shares land in their wallet, not the adapter's.
    expect(deposit.args[3]).toBe(USER);
    // Depositing pulls nothing from the user, so no approval is required.
    expect(bundle.requiresApproval).toEqual([]);
  });

  it("redeems the whole share balance on a full vault exit", () => {
    const bundle = buildRebalanceBundle({
      legs: [vaultLeg(500n, 0n, { shares: 499n }), leg(1, 0n, 500n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const redeem = decode(bundle.calls[0].data);
    expect(redeem.functionName).toBe("erc4626Redeem");
    expect(redeem.args[1]).toBe(499n); // exact share balance, no dust left
    // Signature is (vault, shares, minSharePriceE27, receiver, owner). These two are both addresses,
    // so swapping them still encodes and still hits the same selector — it just sends the proceeds
    // to the wrong place. Assert them explicitly.
    expect(redeem.args[3]).toBe(ADAPTER); // receiver: the bundle spends the proceeds in later legs
    expect(redeem.args[4]).toBe(USER); // owner: whose shares are pulled
  });

  it("sends vault proceeds to the adapter, never straight to the user", () => {
    // If a redeem paid the user directly, the later supply legs would have nothing to spend and the
    // whole bundle would revert on an empty adapter balance.
    const bundle = buildRebalanceBundle({
      legs: [vaultLeg(500n, 0n, { shares: 500n }), leg(1, 0n, 500n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    for (const c of bundle.calls) {
      const d = decode(c.data);
      if (d.functionName === "erc4626Redeem" || d.functionName === "erc4626Withdraw") {
        expect(d.args[3]).toBe(ADAPTER);
        expect(d.args[4]).toBe(USER);
      }
    }
  });

  it("uses an asset-denominated withdraw for a partial vault exit", () => {
    const bundle = buildRebalanceBundle({
      legs: [vaultLeg(500n, 200n), leg(1, 0n, 300n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const w = decode(bundle.calls[0].data);
    expect(w.functionName).toBe("erc4626Withdraw");
    expect(w.args[1]).toBe(300n);
    expect(w.args[3]).toBe(ADAPTER);
    expect(w.args[4]).toBe(USER);
  });

  it("bounds a vault exit from BELOW, not above", () => {
    // Both exits assert assets/shares >= minSharePriceE27. Passing a bound above the quoted price
    // (as a max-style bound would be) makes every exit revert with SlippageExceeded.
    const bundle = buildRebalanceBundle({
      legs: [vaultLeg(500n, 200n, { totalAssets: 1_100_000n, totalShares: 1_000_000n }), leg(1, 0n, 300n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const quoted = ((1_100_000n + 1n) * RAY) / (1_000_000n + 1n);
    const w = decode(bundle.calls[0].data);
    expect(w.args[2]).toBe((quoted * 9990n) / 10000n);
    expect(w.args[2] as bigint).toBeLessThan(quoted);
  });

  it("bounds a vault deposit from ABOVE", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 300n, 0n), vaultLeg(0n, 300n, { totalAssets: 1_100_000n, totalShares: 1_000_000n })],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const quoted = ((1_100_000n + 1n) * RAY) / (1_000_000n + 1n);
    const d = decode(bundle.calls[1].data);
    expect(d.args[2] as bigint).toBeGreaterThan(quoted);
  });

  it("reports the vault approval a bundle needs, and only for exits", () => {
    const exiting = buildRebalanceBundle({
      legs: [vaultLeg(500n, 0n, { shares: 499n }), leg(1, 0n, 500n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    expect(exiting.requiresApproval).toEqual([{ vault: VAULT, shares: 499n }]);

    const entering = buildRebalanceBundle({
      legs: [leg(1, 500n, 0n), vaultLeg(0n, 500n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    expect(entering.requiresApproval).toEqual([]);
  });

  it("rounds the required approval up on a partial exit", () => {
    // 1.5 assets per share: withdrawing 300 assets needs 200 shares exactly.
    const bundle = buildRebalanceBundle({
      legs: [vaultLeg(500n, 200n, { totalAssets: 1_500_000n, totalShares: 1_000_000n }), leg(1, 0n, 300n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    expect(bundle.requiresApproval[0].shares).toBeGreaterThanOrEqual(200n);
  });

  it("bounds the vault share price on both sides", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 300n, 0n), vaultLeg(0n, 300n, { totalAssets: 1_100_000n, totalShares: 1_000_000n })],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const deposit = decode(bundle.calls[1].data);
    const expected = ((1_100_000n + 1n) * RAY) / (1_000_000n + 1n);
    // 0.1% above the quoted price.
    expect(deposit.args[2]).toBe((expected * 10010n) / 10000n);
  });

  it("refuses a vault whose asset is not the pool's loan token", () => {
    const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    expect(() =>
      buildRebalanceBundle({
        legs: [leg(1, 300n, 0n), vaultLeg(0n, 300n, { asset: USDT })],
        user: USER,
        chain,
        loanToken: USDC,
      }),
    ).toThrow(/cannot move value across loan assets/);
  });

  it("mixes markets and vaults in one bundle, withdrawals before deposits", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 500n, 0n), vaultLeg(300n, 0n, { shares: 300n }), leg(2, 0n, 400n), vaultLeg(0n, 400n)],
      user: USER,
      chain,
      loanToken: USDC,
    });
    const kinds = bundle.steps.map((s) => s.kind);
    expect(kinds.slice(0, 2).sort()).toEqual(["vault-redeem", "withdraw"]);
    expect(kinds.filter((k) => k === "supply" || k === "vault-deposit")).toHaveLength(2);
    expect(kinds[kinds.length - 1]).toBe("skim");
  });
});

describe("deploying idle wallet capital", () => {
  it("pulls exactly the shortfall from the wallet as the first call", () => {
    // 1,000 already deployed and moved around, plus 1,000 fresh from the wallet.
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 1_000n, 500n), leg(2, 0n, 900n), leg(3, 0n, 600n)],
      user: USER,
      chain,
      loanToken: USDC,
      walletAvailable: 1_000n,
    });
    expect(bundle.walletPull).toBe(1_000n);
    expect(bundle.steps[0]).toEqual({ kind: "wallet-pull", amount: 1_000n });
    const pull = decode(bundle.calls[0].data);
    expect(pull.functionName).toBe("erc20TransferFrom");
    expect(pull.args).toEqual([USDC, ADAPTER, 1_000n]);
    expect(bundle.steps.map((s) => s.kind)).toEqual(["wallet-pull", "withdraw", "supply", "supply", "skim"]);
  });

  it("never pulls more than the supplies need, even with more idle available", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 0n, 300n)],
      user: USER,
      chain,
      loanToken: USDC,
      walletAvailable: 1_000n,
    });
    expect(bundle.walletPull).toBe(300n);
  });

  it("does not touch the wallet when withdrawals cover the supplies", () => {
    const bundle = buildRebalanceBundle({
      legs: [leg(1, 300n, 100n), leg(2, 0n, 200n)],
      user: USER,
      chain,
      loanToken: USDC,
      walletAvailable: 1_000n,
    });
    expect(bundle.walletPull).toBe(0n);
    expect(bundle.steps[0].kind).toBe("withdraw");
  });

  it("refuses a plan that needs more than the wallet holds", () => {
    expect(() =>
      buildRebalanceBundle({ legs: [leg(1, 0n, 500n)], user: USER, chain, loanToken: USDC, walletAvailable: 100n }),
    ).toThrow(/needs 500 from the wallet but only 100/);
  });
});
