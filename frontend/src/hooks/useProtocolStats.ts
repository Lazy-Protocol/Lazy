import { useQuery } from '@tanstack/react-query';

interface ProtocolStats {
  totalAssets: string;
  totalSupply: string;
  sharePrice: string;
  accumulatedYield: string;
  pendingWithdrawalShares: string;
  totalDeposited: string;
  formatted: {
    tvl: string;
    totalSupply: string;
    sharePrice: string;
    accumulatedYield: string;
    totalDeposited: string;
  };
  depositorCount: number;
  depositCount: number;
  apr: number;
  aprSource: 'static' | 'calculated';
  aprPeriod: '7d' | 'inception' | 'static';
  apr7d?: number | null;
  apr30d?: number | null;
  apr30dSource?: 'calculated' | 'unavailable';
  updatedAt: string;
  vaultAddress: string;
  chainId: number;
  lastYieldReportTime: string;
}

const REMOTE_STATS_URL = 'https://raw.githubusercontent.com/Lazy-Protocol/lazy/main/frontend/public/stats.json';
const STATS_URL = import.meta.env.DEV ? '/stats.json' : REMOTE_STATS_URL;

export function useProtocolStats() {
  return useQuery<ProtocolStats>({
    queryKey: ['protocol-stats'],
    queryFn: async () => {
      // Fetch from GitHub raw to get latest stats without redeploying
      const response = await fetch(`${STATS_URL}?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch stats');
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
  });
}
