import { useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { vaultAbi, erc20Abi } from '@/config/abis';
import { CONTRACTS } from '@/config/wagmi';
import { assertDepositAccess } from '@/config/depositAccess';
import { formatUnits, parseUnits } from 'viem';

// Format USDC (6 decimals)
export function formatUsdc(value: bigint | undefined): string {
  if (!value) return '0.00';
  return Number(formatUnits(value, 6)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Format shares (18 decimals)
export function formatShares(value: bigint | undefined): string {
  if (!value) return '0.00';
  return Number(formatUnits(value, 18)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

// Parse USDC input to bigint
export function parseUsdc(value: string): bigint {
  try {
    return parseUnits(value || '0', 6);
  } catch {
    return 0n;
  }
}

// Parse shares input to bigint
export function parseShares(value: string): bigint {
  try {
    return parseUnits(value || '0', 18);
  } catch {
    return 0n;
  }
}

// Hook to get all vault stats
export function useVaultStats() {
  const results = useReadContracts({
    contracts: [
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'totalAssets',
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'totalSupply',
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'sharePrice',
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'cooldownPeriod',
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'pendingWithdrawalShares',
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'accumulatedYield',
      },
    ],
  });

  return {
    totalAssets: results.data?.[0].result as bigint | undefined,
    totalSupply: results.data?.[1].result as bigint | undefined,
    sharePrice: results.data?.[2].result as bigint | undefined,
    cooldownPeriod: results.data?.[3].result as bigint | undefined,
    pendingWithdrawalShares: results.data?.[4].result as bigint | undefined,
    accumulatedYield: results.data?.[5].result as bigint | undefined,
    isLoading: results.isLoading,
    refetch: results.refetch,
  };
}

// Hook to get user-specific data
export function useUserData(address: `0x${string}` | undefined) {
  const results = useReadContracts({
    contracts: [
      {
        address: CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: address ? [address] : undefined,
      },
      {
        address: CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: address ? [address, CONTRACTS.vault] : undefined,
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: address ? [address] : undefined,
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: 'userTotalDeposited',
        args: address ? [address] : undefined,
      },
    ],
    query: {
      enabled: !!address,
    },
  });

  const shareBalance = results.data?.[2].result as bigint | undefined;

  // Get USDC value of shares
  const usdcValue = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: 'sharesToUsdc',
    args: shareBalance ? [shareBalance] : undefined,
    query: {
      enabled: !!shareBalance && shareBalance > 0n,
    },
  });

  return {
    usdcBalance: results.data?.[0].result as bigint | undefined,
    usdcAllowance: results.data?.[1].result as bigint | undefined,
    shareBalance,
    totalDeposited: results.data?.[3].result as bigint | undefined,
    usdcValue: usdcValue.data as bigint | undefined,
    isLoading: results.isLoading,
    refetch: () => {
      results.refetch();
      usdcValue.refetch();
    },
  };
}

// Hook for deposit transaction
export function useDeposit() {
  const { writeContractAsync } = useWriteContract();

  const deposit = (amount: bigint, account: `0x${string}`) => {
    assertDepositAccess(account);
    return writeContractAsync({
      account,
      chainId: mainnet.id,
      address: CONTRACTS.vault,
      abi: vaultAbi,
      functionName: 'deposit',
      args: [amount],
    });
  };

  return { deposit };
}

// Hook for USDC approval
export function useApprove() {
  const { writeContractAsync } = useWriteContract();

  const approve = (amount: bigint, account: `0x${string}`) => {
    assertDepositAccess(account);
    return writeContractAsync({
      account,
      chainId: mainnet.id,
      address: CONTRACTS.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CONTRACTS.vault, amount],
    });
  };

  return { approve };
}

// Hook for withdrawal request
export function useRequestWithdrawal() {
  const { writeContractAsync } = useWriteContract();

  const requestWithdrawal = (shares: bigint, account: `0x${string}`) => {
    return writeContractAsync({
      account,
      chainId: mainnet.id,
      address: CONTRACTS.vault,
      abi: vaultAbi,
      functionName: 'requestWithdrawal',
      args: [shares],
    });
  };

  return { requestWithdrawal };
}

// Hook to get user's withdrawal requests and queue info
export function useUserWithdrawals(address: `0x${string}` | undefined) {
  const queueLength = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: 'withdrawalQueueLength',
  });

  const queueHead = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: 'withdrawalQueueHead',
  });

  const userPendingCount = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: 'userPendingRequests',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address,
    },
  });

  // Calculate queue depth (pending requests ahead)
  const queueDepth = queueLength.data !== undefined && queueHead.data !== undefined
    ? Number(queueLength.data) - Number(queueHead.data)
    : undefined;

  return {
    queueLength: queueLength.data as bigint | undefined,
    queueHead: queueHead.data as bigint | undefined,
    queueDepth,
    userPendingCount: userPendingCount.data as bigint | undefined,
    isLoading: queueLength.isLoading || queueHead.isLoading || userPendingCount.isLoading,
    refetch: () => {
      queueLength.refetch();
      queueHead.refetch();
      userPendingCount.refetch();
    },
  };
}
