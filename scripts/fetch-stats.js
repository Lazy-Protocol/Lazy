import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env file if present (no dotenv dependency)
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

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

  const outputDir = join(__dirname, '..', 'frontend', 'public');
  const outputPath = join(outputDir, 'stats.json');
  let previousStats = null;
  if (existsSync(outputPath)) {
    try {
      previousStats = JSON.parse(readFileSync(outputPath, 'utf-8'));
    } catch (e) {
      console.warn('Could not parse previous stats for fallback:', e.message);
    }
  }

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
      if (previousStats) {
        uniqueDepositors = new Set(Array.from({ length: Number(previousStats.depositorCount || 0) }, (_, i) => `fallback-${i}`));
        totalDeposited = BigInt(previousStats.totalDeposited || 0);
        depositLogs = Array.from({ length: Number(previousStats.depositCount || 0) }, () => ({}));
        console.warn('Using previous depositor/deposit totals from existing stats.json.');
      } else {
        console.warn('Depositor count will be 0. Consider using an RPC that supports historical logs.');
      }
    }

    // ============================================
    // PPS History & Rolling APRs
    // ============================================

    const ppsHistoryPath = join(__dirname, '..', 'frontend', 'public', 'pps-history.json');
    const navHistoryPath = join(__dirname, '..', 'data', 'nav-history.json');
    const yieldSnapshotsPath = join(__dirname, '..', 'data', 'yield-snapshots.json');
    let ppsHistory = [];

    const addPpsObservation = (observations, timestamp, pps) => {
      const parsedTimestamp = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
      const parsedPps = Number(pps);
      if (!Number.isFinite(parsedTimestamp) || !Number.isFinite(parsedPps) || parsedPps <= 0) return;
      observations.push({
        date: new Date(parsedTimestamp).toISOString().split('T')[0],
        pps: parsedPps,
        timestamp: parsedTimestamp,
      });
    };

    // Load existing PPS history
    if (existsSync(ppsHistoryPath)) {
      try {
        for (const entry of JSON.parse(readFileSync(ppsHistoryPath, 'utf-8'))) {
          addPpsObservation(ppsHistory, entry.timestamp || `${entry.date}T00:00:00.000Z`, entry.pps);
        }
      } catch (e) {
        console.warn('Could not parse PPS history, starting fresh');
        ppsHistory = [];
      }
    }

    // Get today's date (UTC) as YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];
    const currentPPS = Number(formatUnits(sharePrice, 6));

    if (existsSync(navHistoryPath)) {
      try {
        const navHistory = JSON.parse(readFileSync(navHistoryPath, 'utf-8'));
        for (const entry of navHistory.entries || []) {
          addPpsObservation(ppsHistory, entry.timestamp, entry.sharePrice);
        }
      } catch (e) {
        console.warn('Could not parse NAV history for PPS backfill:', e.message);
      }
    }

    if (existsSync(yieldSnapshotsPath)) {
      try {
        const yieldSnapshots = JSON.parse(readFileSync(yieldSnapshotsPath, 'utf-8'));
        for (const snapshot of yieldSnapshots.snapshots || []) {
          addPpsObservation(ppsHistory, snapshot.timestamp, snapshot.sharePrice);
        }
      } catch (e) {
        console.warn('Could not parse yield snapshots for PPS backfill:', e.message);
      }
    }

    addPpsObservation(ppsHistory, new Date().toISOString(), currentPPS);

    // Keep enough history for 7d and 30d rolling comparisons.
    const latestByDate = new Map();
    for (const entry of ppsHistory.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) {
      latestByDate.set(entry.date, entry);
    }
    ppsHistory = [...latestByDate.values()]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-90);

    // Save updated history
    writeFileSync(ppsHistoryPath, JSON.stringify(ppsHistory, null, 2));

    const clampApr = (value) => Math.max(0, Math.min(100, value));
    const roundApr = (value) => Math.round(value * 100) / 100;
    const calculateRollingApr = (windowDays) => {
      const targetTimestamp = Date.now() - windowDays * 24 * 60 * 60 * 1000;
      const maxAgeDays = windowDays + Math.max(2, windowDays * 0.2);
      const minAgeDays = Math.max(1, windowDays - Math.max(2, windowDays * 0.2));
      const candidate = [...ppsHistory]
        .filter((entry) => Number(entry.pps) > 0)
        .sort((a, b) => Math.abs(Number(a.timestamp) - targetTimestamp) - Math.abs(Number(b.timestamp) - targetTimestamp))[0];

      if (!candidate) return null;

      const daysDiff = (Date.now() - Number(candidate.timestamp)) / (1000 * 60 * 60 * 24);
      if (daysDiff < minAgeDays || daysDiff > maxAgeDays) return null;

      const ppsGain = (currentPPS - Number(candidate.pps)) / Number(candidate.pps);
      return clampApr(ppsGain * (365 / daysDiff) * 100);
    };

    // Calculate APR using 7-day rolling window (or inception if < 7 days)
    let apr = STATIC_APR;
    let aprSource = 'static';
    let aprPeriod = 'static';
    let apr7d = null;
    let apr30d = null;
    let apr30dSource = 'unavailable';

    const INITIAL_PPS = 1000000n;

    if (sharePrice > INITIAL_PPS && lastYieldReportTime > 0n) {
      apr7d = calculateRollingApr(7);
      apr30d = calculateRollingApr(30);

      if (apr7d !== null) {
        apr = apr7d;
        aprSource = 'calculated';
        aprPeriod = '7d';
      }

      if (apr30d !== null) {
        apr30dSource = 'calculated';
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

      apr = clampApr(apr);
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
      apr: roundApr(apr), // Backwards-compatible primary APR.
      aprSource, // 'static' or 'calculated'
      aprPeriod, // '7d', 'inception', or 'static'
      apr7d: apr7d === null ? null : roundApr(apr7d),
      apr30d: apr30d === null ? null : roundApr(apr30d),
      apr30dSource,

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
    console.log('  30d APR:', stats.apr30d === null ? 'unavailable' : stats.apr30d + '%');
    console.log('  PPS History:', ppsHistory.length, 'days');
    console.log('  Unique Depositors:', stats.depositorCount);
    console.log('  Total Deposits:', stats.depositCount);

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log('\nStats written to:', outputPath);

    return stats;
  } catch (error) {
    console.error('Error fetching stats:', error);
    process.exit(1);
  }
}

fetchStats();
