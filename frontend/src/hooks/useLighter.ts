import { useQuery } from '@tanstack/react-query';

const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1';

// Market index to symbol mapping
const LIGHTER_MARKETS: Record<number, string> = {
  0: 'ETH',
  1: 'BTC',
  5: 'HYPE',
};

export interface LighterPosition {
  market: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

interface LighterState {
  collateral: number;
  unrealizedPnl: number;
  positions: LighterPosition[];
}

async function fetchLighterState(address: string): Promise<LighterState> {
  try {
    // First get the account index from L1 address
    const accountsRes = await fetch(
      `${LIGHTER_API}/accountsByL1Address?l1_address=${address}`
    );

    if (!accountsRes.ok) {
      console.warn('Lighter API error:', accountsRes.status);
      return { collateral: 0, unrealizedPnl: 0, positions: [] };
    }

    const accountsData = await accountsRes.json();
    const accounts = accountsData.accounts || [];

    if (accounts.length === 0) {
      return { collateral: 0, unrealizedPnl: 0, positions: [] };
    }

    // Use the first account
    const accountIndex = accounts[0].index;

    // Fetch account details
    const detailsRes = await fetch(
      `${LIGHTER_API}/account?account_index=${accountIndex}`
    );

    if (!detailsRes.ok) {
      console.warn('Lighter account API error:', detailsRes.status);
      return { collateral: 0, unrealizedPnl: 0, positions: [] };
    }

    const data = await detailsRes.json();

    // Parse collateral (in USDC, 6 decimals)
    const collateral = parseFloat(data.collateral || 0) / 1e6;

    // Parse positions
    const positions: LighterPosition[] = [];
    let totalUnrealizedPnl = 0;

    const positionsData = data.positions || [];
    for (const pos of positionsData) {
      const size = parseFloat(pos.size || 0);
      if (size === 0) continue;

      const marketIdx = parseInt(pos.market_index || 0);
      const entryPrice = parseFloat(pos.average_entry_price || 0) / 1e8;
      const unrealizedPnl = parseFloat(pos.unrealized_pnl || 0) / 1e6;

      totalUnrealizedPnl += unrealizedPnl;

      positions.push({
        market: LIGHTER_MARKETS[marketIdx] || `Market ${marketIdx}`,
        side: size >= 0 ? 'LONG' : 'SHORT',
        size: Math.abs(size),
        entryPrice,
        unrealizedPnl,
      });
    }

    return {
      collateral,
      unrealizedPnl: totalUnrealizedPnl,
      positions,
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter state:', e);
    return { collateral: 0, unrealizedPnl: 0, positions: [] };
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
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
