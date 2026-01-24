/**
 * Referral Keeper Script
 *
 * Watches vault Deposit events and updates depositor records in FeeDistributor
 * when referred users make additional deposits.
 *
 * Run via GitHub Actions on schedule or manually.
 *
 * Environment variables:
 * - RPC_URL: Ethereum RPC endpoint
 * - KEEPER_PRIVATE_KEY: Private key for keeper wallet
 * - VAULT_ADDRESS: Vault contract address
 * - REGISTRY_ADDRESS: ReferralRegistry contract address
 * - FEE_DISTRIBUTOR_ADDRESS: FeeDistributor contract address
 * - LOOKBACK_BLOCKS: Number of blocks to look back (default: 7200 = ~24 hours)
 */

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

// ABIs for the contracts we need
const vaultAbi = parseAbi([
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
]);

const registryAbi = parseAbi([
  'function referrerOf(address depositor) external view returns (address)',
]);

const feeDistributorAbi = parseAbi([
  'function depositorRecords(address) external view returns (uint256 shares, uint256 entrySharePrice, bool initialized)',
  'function updateDepositorRecords(address[] calldata depositors) external',
]);

// Configuration from environment
const config = {
  rpcUrl: process.env.RPC_URL || 'https://eth.llamarpc.com',
  keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY,
  vaultAddress: process.env.VAULT_ADDRESS || '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805',
  registryAddress: process.env.REGISTRY_ADDRESS,
  feeDistributorAddress: process.env.FEE_DISTRIBUTOR_ADDRESS,
  lookbackBlocks: BigInt(process.env.LOOKBACK_BLOCKS || '7200'), // ~24 hours
};

async function main() {
  console.log('=== Referral Keeper Starting ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Validate config
  if (!config.keeperPrivateKey) {
    console.error('ERROR: KEEPER_PRIVATE_KEY not set');
    process.exit(1);
  }
  if (!config.registryAddress) {
    console.error('ERROR: REGISTRY_ADDRESS not set');
    process.exit(1);
  }
  if (!config.feeDistributorAddress) {
    console.error('ERROR: FEE_DISTRIBUTOR_ADDRESS not set');
    process.exit(1);
  }

  // Create clients
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl),
  });

  const account = privateKeyToAccount(config.keeperPrivateKey);
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(config.rpcUrl),
  });

  console.log(`Keeper address: ${account.address}`);
  console.log(`Vault: ${config.vaultAddress}`);
  console.log(`Registry: ${config.registryAddress}`);
  console.log(`FeeDistributor: ${config.feeDistributorAddress}`);

  // Get current block
  const currentBlock = await publicClient.getBlockNumber();
  const fromBlock = currentBlock - config.lookbackBlocks;
  console.log(`\nScanning blocks ${fromBlock} to ${currentBlock}`);

  // Fetch Deposit events
  const depositLogs = await publicClient.getLogs({
    address: config.vaultAddress,
    event: vaultAbi[0],
    fromBlock,
    toBlock: currentBlock,
  });

  console.log(`Found ${depositLogs.length} deposit events`);

  if (depositLogs.length === 0) {
    console.log('No deposits to process');
    return;
  }

  // Extract unique depositors (owner field from Deposit event)
  const depositors = [...new Set(depositLogs.map(log => log.args.owner))];
  console.log(`Unique depositors: ${depositors.length}`);

  // Filter to only depositors with referrers
  const depositorsWithReferrers = [];

  for (const depositor of depositors) {
    const referrer = await publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: 'referrerOf',
      args: [depositor],
    });

    if (referrer !== '0x0000000000000000000000000000000000000000') {
      // Check if they're initialized in FeeDistributor
      const record = await publicClient.readContract({
        address: config.feeDistributorAddress,
        abi: feeDistributorAbi,
        functionName: 'depositorRecords',
        args: [depositor],
      });

      if (record[2]) { // initialized = true
        depositorsWithReferrers.push(depositor);
        console.log(`  ${depositor} -> referred by ${referrer}`);
      }
    }
  }

  console.log(`\nDepositors with referrers to update: ${depositorsWithReferrers.length}`);

  if (depositorsWithReferrers.length === 0) {
    console.log('No referred depositors need updating');
    return;
  }

  // Batch update (max 50 at a time to avoid gas limits)
  const batchSize = 50;
  for (let i = 0; i < depositorsWithReferrers.length; i += batchSize) {
    const batch = depositorsWithReferrers.slice(i, i + batchSize);
    console.log(`\nProcessing batch ${Math.floor(i / batchSize) + 1} (${batch.length} depositors)`);

    try {
      const hash = await walletClient.writeContract({
        address: config.feeDistributorAddress,
        abi: feeDistributorAbi,
        functionName: 'updateDepositorRecords',
        args: [batch],
      });

      console.log(`  Transaction submitted: ${hash}`);

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
    } catch (error) {
      console.error(`  ERROR: ${error.message}`);
    }
  }

  console.log('\n=== Keeper Complete ===');
}

main().catch(console.error);
