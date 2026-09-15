import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { bundler3Abi } from "../abi/bundler3";
import { generalAdapter1Abi } from "../abi/generalAdapter1";
import { buildRebalanceBundle, encodeBundlerMulticall, type RebalanceLeg } from "./bundle";
import { MAX_UINT256 } from "./math";
import type { MarketParams } from "./types";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ADAPTER: Address = "0xb98c948CFA24072e58935BC004a8A7b376AE746A";
const USER: Address = "0x1111111111111111111111111111111111111111";
const chain = { generalAdapter1: ADAPTER, usdc: USDC };

function params(n: number): MarketParams {
  const addr = `0x${n.toString(16).padStart(40, "0")}` as Address;
  return { loanToken: USDC, collateralToken: addr, oracle: addr, irm: addr, lltv: 860000000000000000n };
}

function leg(n: number, current: bigint, target: bigint): RebalanceLeg {
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
    const bundle = buildRebalanceBundle({ legs: [leg(1, 300n, 100n), leg(2, 0n, 200n)], user: USER, chain });
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
    const bundle = buildRebalanceBundle({ legs: [leg(1, 300n, 0n), leg(2, 0n, 300n)], user: USER, chain });
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
      sweepIntoLastSupply: false,
    });
    const s = decode(bundle.calls[1].data);
    expect(s.args[1]).toBe(400n);
  });

  it("skim transfers the whole USDC balance to the user with skipRevert", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 10n, 0n), leg(2, 0n, 10n)], user: USER, chain });
    const skim = bundle.calls.at(-1)!;
    expect(skim.skipRevert).toBe(true);
    const d = decode(skim.data);
    expect(d.functionName).toBe("erc20Transfer");
    expect(d.args).toEqual([USDC, USER, MAX_UINT256]);
  });

  it("rejects bundles that supply more than they withdraw", () => {
    expect(() => buildRebalanceBundle({ legs: [leg(1, 100n, 50n), leg(2, 0n, 100n)], user: USER, chain })).toThrow(
      /wallet USDC/,
    );
  });

  it("encodes a Bundler3.multicall that round-trips", () => {
    const bundle = buildRebalanceBundle({ legs: [leg(1, 100n, 0n), leg(2, 0n, 100n)], user: USER, chain });
    const data = encodeBundlerMulticall(bundle.calls);
    const decoded = decodeFunctionData({ abi: bundler3Abi, data });
    expect(decoded.functionName).toBe("multicall");
    const calls = decoded.args[0] as readonly { to: Address; data: Hex }[];
    expect(calls).toHaveLength(3);
    expect(calls[0].to).toBe(ADAPTER);
  });
});
