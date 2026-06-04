// Compute lifetime yield for a single LazyUSD vault depositor.
// Reads Deposit/Withdraw/Transfer events for the wallet, then values their
// current shares at the live PPS.

import { createPublicClient, http, formatUnits, parseAbiItem, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const VAULT = '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const WALLET = getAddress(process.argv[2] || '0xd5597936dBBD1B31f70D7a2024409b7a4d032680');

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL),
});

const VAULT_ABI = [
  parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
  parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  parseAbiItem('function balanceOf(address) view returns (uint256)'),
  parseAbiItem('function convertToAssets(uint256) view returns (uint256)'),
  parseAbiItem('function totalAssets() view returns (uint256)'),
  parseAbiItem('function totalSupply() view returns (uint256)'),
];

// chunked getLogs to dodge RPC range limits
async function getAllLogs(filter) {
  const tip = await client.getBlockNumber();
  // Vault was deployed in late 2025 — start a few months before to be safe
  const start = 21000000n;
  const step = 9999n;
  const out = [];
  for (let from = start; from <= tip; from += step + 1n) {
    const to = from + step > tip ? tip : from + step;
    const logs = await client.getLogs({ ...filter, fromBlock: from, toBlock: to });
    if (logs.length) out.push(...logs);
  }
  return out;
}

const fmt = (n, d = 6) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });

async function main() {
  console.log(`Wallet: ${WALLET}`);
  console.log(`Vault:  ${VAULT}\n`);

  const [deposits, withdraws, xferIn, xferOut, balance, totalAssets, totalSupply] = await Promise.all([
    getAllLogs({
      address: VAULT,
      event: VAULT_ABI[0],
      args: { owner: WALLET },
    }),
    getAllLogs({
      address: VAULT,
      event: VAULT_ABI[1],
      args: { owner: WALLET },
    }),
    getAllLogs({
      address: VAULT,
      event: VAULT_ABI[2],
      args: { to: WALLET },
    }),
    getAllLogs({
      address: VAULT,
      event: VAULT_ABI[2],
      args: { from: WALLET },
    }),
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'balanceOf', args: [WALLET] }),
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'totalAssets' }),
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'totalSupply' }),
  ]);

  console.log('=== Deposit events ===');
  let totalDepositedAssets = 0n;
  let totalDepositedShares = 0n;
  for (const log of deposits) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    const date = new Date(Number(block.timestamp) * 1000).toISOString();
    console.log(`  block=${log.blockNumber} ${date}  assets=${fmt(log.args.assets, 6)} USDC  shares=${fmt(log.args.shares, 18)}`);
    totalDepositedAssets += log.args.assets;
    totalDepositedShares += log.args.shares;
  }
  console.log(`  TOTAL: assets=${fmt(totalDepositedAssets, 6)} USDC  shares=${fmt(totalDepositedShares, 18)}\n`);

  console.log('=== Withdraw events ===');
  let totalWithdrawnAssets = 0n;
  let totalWithdrawnShares = 0n;
  for (const log of withdraws) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    const date = new Date(Number(block.timestamp) * 1000).toISOString();
    console.log(`  block=${log.blockNumber} ${date}  assets=${fmt(log.args.assets, 6)} USDC  shares=${fmt(log.args.shares, 18)}`);
    totalWithdrawnAssets += log.args.assets;
    totalWithdrawnShares += log.args.shares;
  }
  if (withdraws.length === 0) console.log('  (none)');
  console.log(`  TOTAL: assets=${fmt(totalWithdrawnAssets, 6)} USDC  shares=${fmt(totalWithdrawnShares, 18)}\n`);

  console.log('=== ALL share transfers involving wallet ===');
  for (const log of [...xferIn, ...xferOut].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    const date = new Date(Number(block.timestamp) * 1000).toISOString();
    const dir = log.args.to.toLowerCase() === WALLET.toLowerCase() ? 'IN ' : 'OUT';
    const ZERO = '0x0000000000000000000000000000000000000000';
    let kind = '';
    if (log.args.from === ZERO) kind = '(mint)';
    else if (log.args.to === ZERO) kind = '(burn)';
    console.log(`  block=${log.blockNumber} ${date} tx=${log.transactionHash}`);
    console.log(`    ${dir} ${kind} from=${log.args.from} to=${log.args.to} shares=${fmt(log.args.value, 18)}`);
  }

  console.log('\n=== Current state ===');
  const currentValue = (balance * totalAssets) / totalSupply;
  const pps = Number(totalAssets) / Number(totalSupply) * 1e12; // 6→18 decimal scaling
  console.log(`  Live PPS:        ${pps.toFixed(6)} USDC/share`);
  console.log(`  Current shares:  ${fmt(balance, 18)}`);
  console.log(`  Current value:   ${fmt(currentValue, 6)} USDC`);

  const netDeposited = totalDepositedAssets - totalWithdrawnAssets;
  const yieldEarned = currentValue + totalWithdrawnAssets - totalDepositedAssets;
  console.log(`\n=== Yield ===`);
  console.log(`  Total deposited:   ${fmt(totalDepositedAssets, 6)} USDC`);
  console.log(`  Total withdrawn:   ${fmt(totalWithdrawnAssets, 6)} USDC`);
  console.log(`  Net principal:     ${fmt(netDeposited, 6)} USDC`);
  console.log(`  Current position:  ${fmt(currentValue, 6)} USDC`);
  console.log(`  YIELD EARNED:      ${fmt(yieldEarned, 6)} USDC`);
  if (totalDepositedAssets > 0n) {
    const pct = Number(yieldEarned) / Number(totalDepositedAssets) * 100;
    console.log(`  Return on deposits: ${pct.toFixed(3)}%`);

    if (deposits.length > 0) {
      const firstBlock = await client.getBlock({ blockNumber: deposits[0].blockNumber });
      const days = (Date.now() / 1000 - Number(firstBlock.timestamp)) / 86400;
      console.log(`  Days since first deposit: ${days.toFixed(2)}`);
      const apr = pct * 365 / days;
      console.log(`  Realized APR (simple):    ${apr.toFixed(3)}%`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
