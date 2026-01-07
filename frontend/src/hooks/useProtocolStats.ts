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
  updatedAt: string;
  vaultAddress: string;
  chainId: number;
}

export function useProtocolStats() {
  return useQuery<ProtocolStats>({
    queryKey: ['protocol-stats'],
    queryFn: async () => {
      const response = await fetch('/stats.json');
      if (!response.ok) {
        throw new Error('Failed to fetch stats');
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
  });
}
