import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Contract configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
// Block when the vault was deployed (update this after deployment)
const DEPLOYMENT_BLOCK = process.env.DEPLOYMENT_BLOCK ? BigInt(process.env.DEPLOYMENT_BLOCK) : 21764000n;

// Vault ABI (only what we need)
const vaultAbi = [
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'sharePrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'accumulatedYield',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    name: 'pendingWithdrawalShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'Deposit',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'usdcAmount', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
];

async function fetchStats() {
  console.log('Fetching protocol stats...');
  console.log('Vault:', VAULT_ADDRESS);
  console.log('RPC:', RPC_URL);

  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  try {
    // Fetch current contract state
    const [totalAssets, totalSupply, sharePrice, accumulatedYield, pendingWithdrawalShares] =
      await Promise.all([
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'totalAssets',
        }),
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'totalSupply',
        }),
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'sharePrice',
        }),
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'accumulatedYield',
        }),
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'pendingWithdrawalShares',
        }),
      ]);

    // Fetch all Deposit events to count unique depositors
    let depositLogs = [];
    let uniqueDepositors = new Set();
    let totalDeposited = 0n;

    try {
      depositLogs = await client.getLogs({
        address: VAULT_ADDRESS,
        event: {
          type: 'event',
          name: 'Deposit',
          inputs: [
            { name: 'user', type: 'address', indexed: true },
            { name: 'usdcAmount', type: 'uint256', indexed: false },
            { name: 'shares', type: 'uint256', indexed: false },
          ],
        },
        fromBlock: DEPLOYMENT_BLOCK,
        toBlock: 'latest',
      });

      // Count unique depositors
      uniqueDepositors = new Set(depositLogs.map((log) => log.args.user));

      // Calculate total deposited from events
      totalDeposited = depositLogs.reduce(
        (sum, log) => sum + (log.args.usdcAmount || 0n),
        0n
      );
    } catch (logError) {
      console.warn('Warning: Could not fetch deposit logs:', logError.message);
      console.warn('Depositor count will be 0. Consider using an RPC that supports historical logs.');
    }

    const stats = {
      // Raw values (as strings to preserve precision)
      totalAssets: totalAssets.toString(),
      totalSupply: totalSupply.toString(),
      sharePrice: sharePrice.toString(),
      accumulatedYield: accumulatedYield.toString(),
      pendingWithdrawalShares: pendingWithdrawalShares.toString(),
      totalDeposited: totalDeposited.toString(),

      // Formatted values for display
      formatted: {
        tvl: formatUnits(totalAssets, 6),
        totalSupply: formatUnits(totalSupply, 18),
        sharePrice: formatUnits(sharePrice, 6), // sharePrice is USDC per share (6 decimals)
        accumulatedYield: formatUnits(accumulatedYield, 6),
        totalDeposited: formatUnits(totalDeposited, 6),
      },

      // Counts
      depositorCount: uniqueDepositors.size,
      depositCount: depositLogs.length,

      // Metadata
      updatedAt: new Date().toISOString(),
      vaultAddress: VAULT_ADDRESS,
      chainId: 1,
    };

    console.log('\nStats:');
    console.log('  TVL:', stats.formatted.tvl, 'USDC');
    console.log('  Share Price:', stats.formatted.sharePrice);
    console.log('  Accumulated Yield:', stats.formatted.accumulatedYield, 'USDC');
    console.log('  Unique Depositors:', stats.depositorCount);
    console.log('  Total Deposits:', stats.depositCount);

    // Write to frontend public directory
    const outputDir = join(__dirname, '..', 'frontend', 'public');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = join(outputDir, 'stats.json');
    writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log('\nStats written to:', outputPath);

    return stats;
  } catch (error) {
    console.error('Error fetching stats:', error);
    process.exit(1);
  }
}

fetchStats();
