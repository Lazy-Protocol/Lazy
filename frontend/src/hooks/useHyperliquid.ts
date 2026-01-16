import { useQuery } from '@tanstack/react-query';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

export interface HyperliquidPosition {
  coin: string;
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  side: 'LONG' | 'SHORT';
}

interface HyperliquidState {
  equity: number;
  positions: HyperliquidPosition[];
}

async function fetchHyperliquidState(address: string): Promise<HyperliquidState> {
  try {
    const response = await fetch(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'clearinghouseState',
        user: address,
      }),
    });

    if (!response.ok) {
      console.warn('Hyperliquid API error:', response.status);
      return { equity: 0, positions: [] };
    }

    const data = await response.json();

    // Extract account equity
    const marginSummary = data.marginSummary || {};
    const equity = parseFloat(marginSummary.accountValue || 0);

    // Extract positions
    const positions: HyperliquidPosition[] = [];
    for (const pos of data.assetPositions || []) {
      const position = pos.position || pos;
      const coin = position.coin || pos.coin;
      const szi = parseFloat(position.szi || pos.szi || 0);

      if (szi === 0) continue;

      positions.push({
        coin,
        size: Math.abs(szi),
        entryPrice: parseFloat(position.entryPx || pos.entryPx || 0),
        unrealizedPnl: parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0),
        side: szi >= 0 ? 'LONG' : 'SHORT',
      });
    }

    return { equity, positions };
  } catch (e) {
    console.warn('Failed to fetch Hyperliquid state:', e);
    return { equity: 0, positions: [] };
  }
}

export function useHyperliquidPositions(address: string) {
  const query = useQuery({
    queryKey: ['hyperliquid-positions', address],
    queryFn: () => fetchHyperliquidState(address),
    enabled: !!address,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });

  return {
    equity: query.data?.equity ?? 0,
    positions: query.data?.positions ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
