import { useQuery } from '@tanstack/react-query';
import { usePublicClient, useBlockNumber } from 'wagmi';
import { formatUnits, parseAbiItem, type PublicClient } from 'viem';
import { CONTRACTS } from '@/config/wagmi';

// Vault deployed at block 24,184,528 (2026-01-07T18:14 UTC)
const VAULT_DEPLOY_BLOCK = 24184528n;

// Event signatures
const DEPOSIT_EVENT = parseAbiItem(
  'event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted)'
);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

// Chunk size for log queries (9999 blocks max per call on public RPCs)
const CHUNK_SIZE = 9999n;

async function getLogsInChunks(
  client: PublicClient,
  params: {
    address: `0x${string}`;
    event: ReturnType<typeof parseAbiItem>;
    args: Record<string, `0x${string}` | null>;
    fromBlock: bigint;
    toBlock: bigint;
  }
) {
  // Build the list of [from, to] ranges, then run in parallel batches
  // so a 800k-block scan finishes in seconds instead of a minute.
  const ranges: Array<[bigint, bigint]> = [];
  let currentFrom = params.fromBlock;
  while (currentFrom <= params.toBlock) {
    const currentTo = currentFrom + CHUNK_SIZE > params.toBlock
      ? params.toBlock
      : currentFrom + CHUNK_SIZE;
    ranges.push([currentFrom, currentTo]);
    currentFrom = currentTo + 1n;
  }

  // Cap concurrency to be friendly to public RPCs.
  const CONCURRENCY = 8;
  const logs: Awaited<ReturnType<typeof client.getLogs>>= [];
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(([from, to]) =>
      client.getLogs({
        address: params.address,
        event: params.event as any,
        args: params.args,
        fromBlock: from,
        toBlock: to,
      })
    ));
    for (const r of results) logs.push(...r);
  }

  return logs;
}

async function fetchWalletYield(
  client: PublicClient,
  address: `0x${string}`,
  currentBlock: bigint
) {
  // Batch read current state
  const [shareBalance, totalAssets, totalSupply] = await Promise.all([
    client.readContract({
      address: CONTRACTS.vault,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [address],
    }) as Promise<bigint>,
    client.readContract({
      address: CONTRACTS.vault,
      abi: [{ type: 'function', name: 'totalAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'totalAssets',
    }) as Promise<bigint>,
    client.readContract({
      address: CONTRACTS.vault,
      abi: [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'totalSupply',
    }) as Promise<bigint>,
  ]);

  // Calculate current value (shares are 18 decimals, USDC is 6 decimals)
  // currentValue = shareBalance * totalAssets / totalSupply
  const currentValue = totalSupply > 0n
    ? (shareBalance * totalAssets) / totalSupply
    : 0n;

  // Query event logs in parallel
  const [depositLogs, usdcTransferLogs] = await Promise.all([
    // Deposits where wallet is the depositing user
    getLogsInChunks(client, {
      address: CONTRACTS.vault,
      event: DEPOSIT_EVENT,
      args: { user: address },
      fromBlock: VAULT_DEPLOY_BLOCK,
      toBlock: currentBlock,
    }),
    // USDC transfers from vault to wallet (redemptions)
    getLogsInChunks(client, {
      address: CONTRACTS.usdc,
      event: TRANSFER_EVENT,
      args: { from: CONTRACTS.vault, to: address },
      fromBlock: VAULT_DEPLOY_BLOCK,
      toBlock: currentBlock,
    }),
  ]);

  // Sum total deposited (USDC assets from Deposit events)
  let totalDeposited = 0n;
  let firstDepositBlock: bigint | null = null;

  for (const log of depositLogs) {
    const assets = (log as any).args.usdcAmount as bigint;
    totalDeposited += assets;
    if (log.blockNumber !== null && (firstDepositBlock === null || log.blockNumber < firstDepositBlock)) {
      firstDepositBlock = log.blockNumber;
    }
  }

  // Sum total redeemed (USDC received from vault)
  let totalRedeemed = 0n;
  for (const log of usdcTransferLogs) {
    const value = (log as any).args.value as bigint;
    totalRedeemed += value;
  }

  // Get first deposit timestamp if we have deposits
  let firstDepositAt: number | null = null;
  if (firstDepositBlock !== null) {
    const block = await client.getBlock({ blockNumber: firstDepositBlock });
    firstDepositAt = Number(block.timestamp) * 1000; // Convert to milliseconds
  }

  // Check for cost-basis-unknown edge case
  // If user has shares but no deposits, they acquired via Transfer
  const hasCostBasis = totalDeposited > 0n;
  const hasShares = shareBalance > 0n;

  // Calculate yield metrics
  let totalYield: number;
  let profitLossPercent: number;
  let realizedApr: number | null = null;
  let daysHeld: number | null = null;

  if (!hasCostBasis && hasShares) {
    // Cost basis unknown, cannot compute yield
    totalYield = 0;
    profitLossPercent = 0;
  } else if (totalDeposited === 0n) {
    // No deposits, no shares, no yield
    totalYield = 0;
    profitLossPercent = 0;
  } else {
    // Normal case: we have cost basis
    // totalYield = currentValue + totalRedeemed - totalDeposited (in USDC, 6 decimals)
    const yieldBigInt = currentValue + totalRedeemed - totalDeposited;
    totalYield = Number(formatUnits(yieldBigInt, 6));

    // Profit/loss percent
    const depositedNum = Number(formatUnits(totalDeposited, 6));
    profitLossPercent = depositedNum > 0 ? (totalYield / depositedNum) * 100 : 0;

    // Calculate days held and APR
    if (firstDepositAt !== null) {
      daysHeld = (Date.now() - firstDepositAt) / 86400000;
      if (daysHeld >= 1) {
        realizedApr = (profitLossPercent * 365) / daysHeld;
      }
    }
  }

  return {
    currentValue,
    totalDeposited,
    totalRedeemed,
    totalYield,
    profitLossPercent,
    realizedApr,
    daysHeld,
  };
}

export function useWalletYield(address: `0x${string}` | undefined) {
  const client = usePublicClient();
  const { data: blockNumber } = useBlockNumber({ watch: false });

  // Bucket block number to refetch roughly every 10 minutes (~50 blocks)
  const blockTipBucket = blockNumber ? blockNumber / 50n : undefined;

  const { data, isLoading, error } = useQuery({
    queryKey: ['wallet-yield', address, blockTipBucket?.toString()],
    queryFn: async () => {
      if (!client || !address || !blockNumber) {
        throw new Error('Missing client, address, or block number');
      }
      return fetchWalletYield(client, address, blockNumber);
    },
    enabled: !!client && !!address && !!blockNumber,
    staleTime: 10 * 60 * 1000, // 10 minutes
  });

  return {
    isLoading,
    error,
    currentValue: data?.currentValue ?? 0n,
    totalDeposited: data?.totalDeposited ?? 0n,
    totalRedeemed: data?.totalRedeemed ?? 0n,
    totalYield: data?.totalYield ?? 0,
    profitLossPercent: data?.profitLossPercent ?? 0,
    realizedApr: data?.realizedApr ?? null,
    daysHeld: data?.daysHeld ?? null,
  };
}
