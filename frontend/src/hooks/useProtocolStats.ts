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
  updatedAt: string;
  vaultAddress: string;
  chainId: number;
  lastYieldReportTime: string;
}

const STATS_URL = 'https://raw.githubusercontent.com/sirmoremoney/AYP/main/frontend/public/stats.json';

// Hardcoded APR until yield calculation is stable
const HARDCODED_APR = 10;

export function useProtocolStats() {
  return useQuery<ProtocolStats>({
    queryKey: ['protocol-stats'],
    queryFn: async () => {
      // Fetch from GitHub raw to get latest stats without redeploying
      const response = await fetch(`${STATS_URL}?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch stats');
      }
      const stats = await response.json();
      // Override APR with hardcoded value for now
      return {
        ...stats,
        apr: HARDCODED_APR,
        aprSource: 'static' as const,
      };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
  });
}
