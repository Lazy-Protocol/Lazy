import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Contract configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
// Block when the vault was deployed (update this after deployment)
const DEPLOYMENT_BLOCK = process.env.DEPLOYMENT_BLOCK ? BigInt(process.env.DEPLOYMENT_BLOCK) : 21764000n;
// Deployment timestamp (Unix seconds) - first real deposit: Jan 8, 2026 ~14:00 UTC
const DEPLOYMENT_TIMESTAMP = process.env.DEPLOYMENT_TIMESTAMP ? Number(process.env.DEPLOYMENT_TIMESTAMP) : 1767879833;
// Static APR to show before yield data is available (in percent)
const STATIC_APR = 10;

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
    name: 'lastYieldReportTime',
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
    const [totalAssets, totalSupply, sharePrice, accumulatedYield, pendingWithdrawalShares, lastYieldReportTime] =
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
        client.readContract({
          address: VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'lastYieldReportTime',
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

    // ============================================
    // PPS History & 7-Day Rolling APR
    // ============================================

    const ppsHistoryPath = join(__dirname, '..', 'frontend', 'public', 'pps-history.json');
    let ppsHistory = [];

    // Load existing PPS history
    if (existsSync(ppsHistoryPath)) {
      try {
        ppsHistory = JSON.parse(readFileSync(ppsHistoryPath, 'utf-8'));
      } catch (e) {
        console.warn('Could not parse PPS history, starting fresh');
        ppsHistory = [];
      }
    }

    // Get today's date (UTC) as YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];
    const currentPPS = Number(formatUnits(sharePrice, 6));

    // Add or update today's PPS entry
    const existingIndex = ppsHistory.findIndex(entry => entry.date === today);
    if (existingIndex >= 0) {
      ppsHistory[existingIndex].pps = currentPPS;
      ppsHistory[existingIndex].timestamp = Date.now();
    } else {
      ppsHistory.push({
        date: today,
        pps: currentPPS,
        timestamp: Date.now(),
      });
    }

    // Keep only last 30 days of history
    ppsHistory = ppsHistory
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-30);

    // Save updated history
    writeFileSync(ppsHistoryPath, JSON.stringify(ppsHistory, null, 2));

    // Calculate APR using 7-day rolling window (or inception if < 7 days)
    let apr = STATIC_APR;
    let aprSource = 'static';
    let aprPeriod = 'static';

    const INITIAL_PPS = 1000000n;

    if (sharePrice > INITIAL_PPS && lastYieldReportTime > 0n) {
      // Try 7-day rolling APR first
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

      // Find PPS from ~7 days ago (closest available)
      const oldEntry = ppsHistory.find(entry => entry.date <= sevenDaysAgoStr);

      if (oldEntry && ppsHistory.length >= 7) {
        // Use 7-day rolling APR
        const oldPPS = oldEntry.pps;
        const daysDiff = (Date.now() - oldEntry.timestamp) / (1000 * 60 * 60 * 24);

        if (oldPPS > 0 && daysDiff >= 6) {
          const ppsGain = (currentPPS - oldPPS) / oldPPS;
          apr = ppsGain * (365 / daysDiff) * 100;
          aprSource = 'calculated';
          aprPeriod = '7d';
        }
      }

      // Fall back to inception-to-date if we don't have 7 days
      if (aprPeriod !== '7d') {
        const now = Math.floor(Date.now() / 1000);
        const elapsedSeconds = now - DEPLOYMENT_TIMESTAMP;
        const elapsedDays = elapsedSeconds / 86400;

        if (elapsedDays >= 1) {
          const ppsGain = currentPPS - 1.0; // Initial PPS is 1.0
          apr = ppsGain * (365 / elapsedDays) * 100;
          aprSource = 'calculated';
          aprPeriod = 'inception';
        }
      }

      // Cap APR at reasonable bounds (0-100%)
      apr = Math.max(0, Math.min(100, apr));
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

      // APR
      apr: Math.round(apr * 100) / 100, // Round to 2 decimal places
      aprSource, // 'static' or 'calculated'
      aprPeriod, // '7d', 'inception', or 'static'

      // Metadata
      updatedAt: new Date().toISOString(),
      vaultAddress: VAULT_ADDRESS,
      chainId: 1,
      lastYieldReportTime: lastYieldReportTime.toString(),
    };

    console.log('\nStats:');
    console.log('  TVL:', stats.formatted.tvl, 'USDC');
    console.log('  Share Price:', stats.formatted.sharePrice);
    console.log('  Accumulated Yield:', stats.formatted.accumulatedYield, 'USDC');
    console.log('  APR:', stats.apr + '%', `(${stats.aprPeriod} ${stats.aprSource})`);
    console.log('  PPS History:', ppsHistory.length, 'days');
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
