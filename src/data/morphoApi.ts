import type { Address, Hex } from "viem";

const ENDPOINT = "https://api.morpho.org/graphql";

export interface ApiAsset {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface ApiReward {
  asset: { address: Address; symbol: string } | null;
  supplyApr: number | null;
}

export interface ApiMarketState {
  supplyApy: number | null;
  netSupplyApy: number | null;
  utilization: number | null;
  supplyAssets: string | null;
  borrowAssets: string | null;
  supplyAssetsUsd: number | null;
  liquidityAssets: string | null;
  fee: number | null;
  rewards: ApiReward[] | null;
}

export interface ApiMarket {
  /** Morpho Blue market id. The API calls this `marketId`; the filter input still calls it `uniqueKey_in`. */
  marketId: Hex;
  lltv: string;
  irmAddress: Address;
  listed: boolean;
  loanAsset: ApiAsset;
  collateralAsset: ApiAsset | null;
  state: ApiMarketState | null;
}

export interface ApiPosition {
  marketId: Hex;
  loanAsset: Address;
  supplyShares: bigint;
  supplyAssets: bigint;
}

interface GqlError {
  message: string;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: GqlError[] };
  if (json.errors?.length) throw new Error(`Morpho API: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("Morpho API returned no data");
  return json.data;
}

const MARKET_FIELDS = `
  marketId
  lltv
  irmAddress
  listed
  loanAsset { address symbol decimals }
  collateralAsset { address symbol decimals }
  state {
    supplyApy
    netSupplyApy
    utilization
    supplyAssets
    borrowAssets
    supplyAssetsUsd
    liquidityAssets
    fee
    rewards { asset { address symbol } supplyApr }
  }
`;

/**
 * All listed markets on a chain for the given loan assets, largest first. Idle markets (no
 * collateral) are excluded.
 */
export async function fetchMarketsForAssets(chainId: number, assets: Address[]): Promise<ApiMarket[]> {
  if (assets.length === 0) return [];
  const pageSize = 100;
  const all: ApiMarket[] = [];
  // Markets are paged across all requested assets at once; 1000 covers every listed stable market
  // on both chains with plenty of head-room.
  for (let skip = 0; skip < 1000; skip += pageSize) {
    const data = await gql<{ markets: { items: ApiMarket[] } }>(
      `query Markets($chainId: Int!, $assets: [String!]!, $first: Int!, $skip: Int!) {
        markets(
          first: $first
          skip: $skip
          orderBy: SupplyAssetsUsd
          orderDirection: Desc
          where: { chainId_in: [$chainId], loanAssetAddress_in: $assets, listed: true }
        ) { items { ${MARKET_FIELDS} } }
      }`,
      { chainId, assets: assets.map((a) => a.toLowerCase()), first: pageSize, skip },
    );
    const items = data.markets.items;
    all.push(...items.filter((m) => m.collateralAsset !== null));
    if (items.length < pageSize) break;
  }
  return all;
}

/** Fetch metadata for specific markets by id (used for whitelisted or held markets missing from the list). */
export async function fetchMarketsByIds(chainId: number, ids: Hex[]): Promise<ApiMarket[]> {
  if (ids.length === 0) return [];
  const data = await gql<{ markets: { items: ApiMarket[] } }>(
    `query MarketsByIds($chainId: Int!, $ids: [String!]!) {
      markets(first: 100, where: { chainId_in: [$chainId], uniqueKey_in: $ids }) { items { ${MARKET_FIELDS} } }
    }`, // the filter input is still spelled uniqueKey_in even though the field is marketId
    { chainId, ids: ids.map((i) => i.toLowerCase()) },
  );
  return data.markets.items;
}

/** The user's Morpho Blue supply positions on a chain (any loan asset; caller filters). */
export async function fetchUserPositions(chainId: number, address: Address): Promise<ApiPosition[]> {
  try {
    const data = await gql<{
      userByAddress: {
        marketPositions: {
          market: { marketId: Hex; loanAsset: { address: Address } };
          state: { supplyShares: string | null; supplyAssets: string | null } | null;
        }[];
      } | null;
    }>(
      `query Positions($chainId: Int!, $address: String!) {
        userByAddress(chainId: $chainId, address: $address) {
          marketPositions {
            market { marketId loanAsset { address } }
            state { supplyShares supplyAssets }
          }
        }
      }`,
      { chainId, address: address.toLowerCase() },
    );
    const positions = data.userByAddress?.marketPositions ?? [];
    return positions
      .filter((p) => p.state && BigInt(p.state.supplyShares ?? "0") > 0n)
      .map((p) => ({
        marketId: p.market.marketId,
        loanAsset: p.market.loanAsset.address,
        supplyShares: BigInt(p.state!.supplyShares ?? "0"),
        supplyAssets: BigInt(p.state!.supplyAssets ?? "0"),
      }));
  } catch (err) {
    // The API returns an error for addresses it has never seen; treat that as "no positions".
    if (err instanceof Error && /not found|no user/i.test(err.message)) return [];
    throw err;
  }
}

export function rewardApr(m: ApiMarket): number {
  return (m.state?.rewards ?? []).reduce((acc, r) => acc + (r.supplyApr ?? 0), 0);
}

export interface ApiVault {
  address: Address;
  name: string;
  symbol: string;
  asset: ApiAsset;
  state: {
    apy: number | null;
    netApy: number | null;
    fee: number | null;
    totalAssets: string | null;
    totalAssetsUsd: number | null;
    rewards: { asset: { symbol: string } | null; supplyApr: number | null }[] | null;
  } | null;
}

const VAULT_FIELDS = `
  address
  name
  symbol
  asset { address symbol decimals }
  state {
    apy
    netApy
    fee
    totalAssets
    totalAssetsUsd
    # The API renamed VaultState.rewards to allRewards; aliased so the rest of the app is unchanged.
    rewards: allRewards { asset { symbol } supplyApr }
  }
`;

/** Listed vaults on a chain whose underlying asset is one this app manages. */
export async function fetchVaultsForAssets(chainId: number, assets: Address[]): Promise<ApiVault[]> {
  if (assets.length === 0) return [];
  const wanted = new Set(assets.map((a) => a.toLowerCase()));
  const data = await gql<{ vaults: { items: ApiVault[] } }>(
    `query Vaults($chainId: Int!) {
      vaults(first: 500, where: { chainId_in: [$chainId], listed: true }) { items { ${VAULT_FIELDS} } }
    }`,
    { chainId },
  );
  // The vault filter has no loan-asset input, so the asset match happens here.
  return data.vaults.items.filter((v) => wanted.has(v.asset.address.toLowerCase()));
}

export function vaultRewardApr(v: ApiVault): number {
  return (v.state?.rewards ?? []).reduce((acc, r) => acc + (r.supplyApr ?? 0), 0);
}
