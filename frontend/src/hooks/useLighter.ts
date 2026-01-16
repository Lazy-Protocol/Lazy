import { useQuery } from '@tanstack/react-query';

const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1';
const LIGHTER_EXPLORER_API = 'https://explorer.elliot.ai/api';

// Market index to symbol mapping
const LIGHTER_MARKETS: Record<number, string> = {
  0: 'ETH',
  1: 'BTC',
  24: 'HYPE',
};

export interface LighterPosition {
  market: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

export interface LighterSpotAsset {
  symbol: string;
  balance: number;
}

interface LighterState {
  collateral: number;
  unrealizedPnl: number;
  positions: LighterPosition[];
  spotAssets: LighterSpotAsset[];
}

async function fetchLighterState(address: string): Promise<LighterState> {
  try {
    // First get the account index and collateral from L1 address
    const accountsRes = await fetch(
      `${LIGHTER_API}/accountsByL1Address?l1_address=${address}`
    );

    if (!accountsRes.ok) {
      console.warn('Lighter API error:', accountsRes.status);
      return { collateral: 0, unrealizedPnl: 0, positions: [], spotAssets: [] };
    }

    const accountsData = await accountsRes.json();
    const subAccounts = accountsData.sub_accounts || [];

    if (subAccounts.length === 0) {
      return { collateral: 0, unrealizedPnl: 0, positions: [], spotAssets: [] };
    }

    // Sum collateral from all sub-accounts and get account index
    let totalCollateral = 0;
    let accountIndex = 0;
    for (const account of subAccounts) {
      totalCollateral += parseFloat(account.collateral || 0);
      if (account.index) {
        accountIndex = account.index;
      }
    }

    // Fetch positions and spot assets from explorer API in parallel
    const [positionsRes, assetsRes] = await Promise.all([
      fetch(`${LIGHTER_EXPLORER_API}/accounts/${accountIndex}/positions`),
      fetch(`${LIGHTER_EXPLORER_API}/accounts/${accountIndex}/assets`),
    ]);

    const positions: LighterPosition[] = [];
    let totalUnrealizedPnl = 0;

    if (positionsRes.ok) {
      const positionsData = await positionsRes.json();

      for (const [marketIdx, position] of Object.entries(positionsData.positions || {})) {
        const pos = position as { pnl: string; side: string; size: string; entry_price: string };
        const pnl = parseFloat(pos.pnl || '0');
        const size = parseFloat(pos.size || '0');

        if (size === 0) continue;

        totalUnrealizedPnl += pnl;

        positions.push({
          market: LIGHTER_MARKETS[parseInt(marketIdx)] || `Market ${marketIdx}`,
          side: pos.side === 'short' ? 'SHORT' : 'LONG',
          size: Math.abs(size),
          entryPrice: parseFloat(pos.entry_price || '0'),
          unrealizedPnl: pnl,
        });
      }
    }

    // Parse spot assets (LIT, USDC, etc.)
    const spotAssets: LighterSpotAsset[] = [];
    if (assetsRes.ok) {
      const assetsData = await assetsRes.json();
      for (const asset of Object.values(assetsData.assets || {})) {
        const a = asset as { symbol: string; balance: string };
        const balance = parseFloat(a.balance || '0');
        if (balance > 0) {
          spotAssets.push({
            symbol: a.symbol,
            balance,
          });
        }
      }
    }

    return {
      collateral: totalCollateral,
      unrealizedPnl: totalUnrealizedPnl,
      positions,
      spotAssets,
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter state:', e);
    return { collateral: 0, unrealizedPnl: 0, positions: [], spotAssets: [] };
  }
}

export function useLighterPositions(address: string) {
  const query = useQuery({
    queryKey: ['lighter-positions', address],
    queryFn: () => fetchLighterState(address),
    enabled: !!address,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });

  return {
    collateral: query.data?.collateral ?? 0,
    unrealizedPnl: query.data?.unrealizedPnl ?? 0,
    positions: query.data?.positions ?? [],
    spotAssets: query.data?.spotAssets ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
