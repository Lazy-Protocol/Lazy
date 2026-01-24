import { useReadContract, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACTS } from '@/config/wagmi';
import { referralRegistryAbi, feeDistributorAbi } from '@/config/abis';

/**
 * Hook for KOL dashboard data
 */
export function useKOLData(address: `0x${string}` | undefined) {
  // Get KOL info from registry
  const { data: kolInfo, isLoading: kolLoading, refetch: refetchKol } = useReadContract({
    address: CONTRACTS.referralRegistry as `0x${string}`,
    abi: referralRegistryAbi,
    functionName: 'kols',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CONTRACTS.referralRegistry },
  });

  // Get referral count
  const { data: referralCount } = useReadContract({
    address: CONTRACTS.referralRegistry as `0x${string}`,
    abi: referralRegistryAbi,
    functionName: 'getReferralCount',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CONTRACTS.referralRegistry },
  });

  // Get referral list
  const { data: referrals } = useReadContract({
    address: CONTRACTS.referralRegistry as `0x${string}`,
    abi: referralRegistryAbi,
    functionName: 'getReferrals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CONTRACTS.referralRegistry },
  });

  // Parse KOL data
  const parsed = kolInfo ? {
    handle: kolInfo[0] as string,
    feeShareBps: Number(kolInfo[1]),
    active: kolInfo[2] as boolean,
    totalReferred: Number(kolInfo[3]),
    totalEarned: kolInfo[4] as bigint,
  } : null;

  const isKOL = parsed?.active && parsed?.handle?.length > 0;

  return {
    isKOL,
    handle: parsed?.handle || '',
    feeShareBps: parsed?.feeShareBps || 0,
    feeSharePercent: parsed ? (parsed.feeShareBps / 100).toFixed(1) : '0',
    active: parsed?.active || false,
    totalReferred: parsed?.totalReferred || 0,
    totalEarned: parsed?.totalEarned || 0n,
    totalEarnedFormatted: parsed?.totalEarned
      ? formatUnits(parsed.totalEarned, 6)
      : '0',
    referralCount: referralCount ? Number(referralCount) : 0,
    referrals: (referrals as `0x${string}`[]) || [],
    isLoading: kolLoading,
    refetch: refetchKol,
  };
}

/**
 * Hook for KOL earnings preview and distribution data
 */
export function useKOLEarnings(address: `0x${string}` | undefined) {
  const results = useReadContracts({
    contracts: [
      // Preview pending earnings
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'previewKOLEarnings',
        args: address ? [address] : undefined,
      },
      // Preview total yield from referrals
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'previewKOLReferralYield',
        args: address ? [address] : undefined,
      },
      // Get total AUM
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'getKOLTotalAUM',
        args: address ? [address] : undefined,
      },
      // Next distribution time
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'nextDistribution',
      },
      // Time until distribution
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'timeUntilDistribution',
      },
      // Can distribute now?
      {
        address: CONTRACTS.feeDistributor as `0x${string}`,
        abi: feeDistributorAbi,
        functionName: 'canDistribute',
      },
    ],
    query: {
      enabled: !!address && !!CONTRACTS.feeDistributor,
      refetchInterval: 60000, // Refresh every minute
    },
  });

  const pendingEarnings = results.data?.[0]?.result as bigint | undefined;
  const referralYield = results.data?.[1]?.result as bigint | undefined;
  const totalAUM = results.data?.[2]?.result as bigint | undefined;
  const nextDistribution = results.data?.[3]?.result as bigint | undefined;
  const timeUntil = results.data?.[4]?.result as bigint | undefined;
  const canDistribute = results.data?.[5]?.result as boolean | undefined;

  return {
    pendingEarnings: pendingEarnings || 0n,
    pendingEarningsFormatted: pendingEarnings
      ? formatUnits(pendingEarnings, 6)
      : '0',
    referralYield: referralYield || 0n,
    referralYieldFormatted: referralYield
      ? formatUnits(referralYield, 6)
      : '0',
    totalAUM: totalAUM || 0n,
    totalAUMFormatted: totalAUM
      ? formatUnits(totalAUM, 6)
      : '0',
    nextDistribution: nextDistribution ? Number(nextDistribution) : 0,
    timeUntilDistribution: timeUntil ? Number(timeUntil) : 0,
    canDistribute: canDistribute || false,
    isLoading: results.isLoading,
    refetch: results.refetch,
  };
}

/**
 * Resolve a handle to an address
 */
export function useResolveHandle(handle: string | undefined) {
  const { data, isLoading } = useReadContract({
    address: CONTRACTS.referralRegistry as `0x${string}`,
    abi: referralRegistryAbi,
    functionName: 'resolveHandle',
    args: handle ? [handle] : undefined,
    query: { enabled: !!handle && !!CONTRACTS.referralRegistry },
  });

  const address = data as `0x${string}` | undefined;
  const isValid = address && address !== '0x0000000000000000000000000000000000000000';

  return {
    address: isValid ? address : null,
    isValid,
    isLoading,
  };
}

/**
 * Check if an address has a referrer
 */
export function useReferrerOf(depositor: `0x${string}` | undefined) {
  const { data, isLoading } = useReadContract({
    address: CONTRACTS.referralRegistry as `0x${string}`,
    abi: referralRegistryAbi,
    functionName: 'referrerOf',
    args: depositor ? [depositor] : undefined,
    query: { enabled: !!depositor && !!CONTRACTS.referralRegistry },
  });

  const referrer = data as `0x${string}` | undefined;
  const hasReferrer = referrer && referrer !== '0x0000000000000000000000000000000000000000';

  return {
    referrer: hasReferrer ? referrer : null,
    hasReferrer,
    isLoading,
  };
}

/**
 * Format USDC amount for display
 */
export function formatUsdcAmount(amount: bigint, decimals: number = 2): string {
  const value = Number(formatUnits(amount, 6));
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
