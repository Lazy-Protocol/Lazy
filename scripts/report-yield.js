import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Contract configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';

// Vault ABI (only reportYieldAndCollectFees)
const vaultAbi = [
  {
    name: 'reportYieldAndCollectFees',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'yieldDelta', type: 'int256' }],
    outputs: [],
  },
  {
    name: 'accumulatedYield',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    name: 'lastYieldReportTime',
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
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

async function reportYield() {
  // Get yield amount from command line args
  const yieldAmount = process.argv[2];

  if (!yieldAmount) {
    console.error('Usage: node report-yield.js <amount>');
    console.error('Example: node report-yield.js 250   (reports $250 yield)');
    console.error('Example: node report-yield.js -100  (reports $100 loss)');
    process.exit(1);
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: PRIVATE_KEY environment variable not set');
    console.error('Set it with: export PRIVATE_KEY=your_private_key_here');
    process.exit(1);
  }

  // Parse yield amount to USDC (6 decimals)
  const yieldDelta = parseUnits(yieldAmount, 6);

  console.log('='.repeat(50));
  console.log('Report Yield to LazyUSD Vault');
  console.log('='.repeat(50));
  console.log(`Vault: ${VAULT_ADDRESS}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Yield Delta: $${yieldAmount} (${yieldDelta.toString()} raw)`);
  console.log('');

  // Create clients
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(RPC_URL),
  });

  console.log(`Operator: ${account.address}`);
  console.log('');

  // Get current state before reporting
  const [accumulatedYieldBefore, lastReportTime, sharePriceBefore, totalAssetsBefore] = await Promise.all([
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'accumulatedYield',
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'lastYieldReportTime',
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'sharePrice',
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'totalAssets',
    }),
  ]);

  console.log('Current State:');
  console.log(`  Accumulated Yield: $${(Number(accumulatedYieldBefore) / 1e6).toFixed(2)}`);
  console.log(`  Share Price: ${(Number(sharePriceBefore) / 1e6).toFixed(6)}`);
  console.log(`  Total Assets: $${(Number(totalAssetsBefore) / 1e6).toFixed(2)}`);

  if (lastReportTime > 0n) {
    const lastReportDate = new Date(Number(lastReportTime) * 1000);
    const hoursSinceReport = (Date.now() - lastReportDate.getTime()) / (1000 * 60 * 60);
    console.log(`  Last Report: ${lastReportDate.toISOString()} (${hoursSinceReport.toFixed(1)}h ago)`);

    if (hoursSinceReport < 24) {
      console.log('\nWarning: Last report was less than 24 hours ago.');
      console.log('The contract requires MIN_YIELD_REPORT_INTERVAL (1 day) between reports.');
      console.log('This transaction may revert with "ReportTooSoon" error.');
    }
  }
  console.log('');

  // Simulate the transaction first
  console.log('Simulating transaction...');
  try {
    await publicClient.simulateContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'reportYieldAndCollectFees',
      args: [yieldDelta],
      account: account.address,
    });
    console.log('Simulation successful!');
  } catch (simError) {
    console.error('Simulation failed:', simError.message);
    if (simError.message.includes('ReportTooSoon')) {
      console.error('\nThe contract requires 24 hours between yield reports.');
    } else if (simError.message.includes('YieldChangeTooLarge')) {
      console.error('\nThe yield change exceeds maxYieldChangePercent (default 0.5% of NAV).');
    } else if (simError.message.includes('Unauthorized') || simError.message.includes('OnlyOperator')) {
      console.error('\nThe caller is not authorized. Must be owner or operator.');
    }
    process.exit(1);
  }
  console.log('');

  // Send the transaction
  console.log('Sending transaction...');
  const hash = await walletClient.writeContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: 'reportYieldAndCollectFees',
    args: [yieldDelta],
  });

  console.log(`Transaction hash: ${hash}`);
  console.log('Waiting for confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status === 'success') {
    console.log('');
    console.log('Transaction confirmed!');
    console.log(`Block: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);

    // Get updated state
    const [accumulatedYieldAfter, sharePriceAfter, totalAssetsAfter] = await Promise.all([
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'accumulatedYield',
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'sharePrice',
      }),
      publicClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'totalAssets',
      }),
    ]);

    console.log('');
    console.log('Updated State:');
    console.log(`  Accumulated Yield: $${(Number(accumulatedYieldAfter) / 1e6).toFixed(2)} (was $${(Number(accumulatedYieldBefore) / 1e6).toFixed(2)})`);
    console.log(`  Share Price: ${(Number(sharePriceAfter) / 1e6).toFixed(6)} (was ${(Number(sharePriceBefore) / 1e6).toFixed(6)})`);
    console.log(`  Total Assets: $${(Number(totalAssetsAfter) / 1e6).toFixed(2)} (was $${(Number(totalAssetsBefore) / 1e6).toFixed(2)})`);
    console.log('');
    console.log('Yield reported successfully!');
  } else {
    console.error('Transaction failed!');
    process.exit(1);
  }
}

reportYield().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
