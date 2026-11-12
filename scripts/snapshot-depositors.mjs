// Read-only capture of depositors eligible before invite-only deposits begin.
// Run manually once. Recapturing later would admit new direct-contract depositors.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeEventLog, getAddress, http, parseAbiItem, toEventSelector } from 'viem';
import { mainnet } from 'viem/chains';

const root = new URL('../', import.meta.url);
const output = new URL('frontend/src/config/grandfathered-depositors.json', root);
const vault = '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';
const depositEvent = parseAbiItem('event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted)');

async function setting(key) {
  if (process.env[key]) return process.env[key];
  const text = await readFile(new URL('.env', root), 'utf8').catch(() => '');
  const value = text.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
  return value?.replace(/^(['"])(.*)\1$/, '$2');
}

async function readClient() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(await setting('ETH_RPC_URL') || 'https://ethereum-rpc.publicnode.com', {timeout: 15_000, retryCount: 2}),
  });
  if (await client.getChainId() !== mainnet.id) throw new Error('RPC chain identity mismatch.');
  return client;
}

const totalDepositedAbi = [parseAbiItem('function totalDeposited() view returns (uint256)')];

async function verify() {
  const saved = JSON.parse(await readFile(output, 'utf8'));
  if (saved.chainId !== mainnet.id || saved.vault.toLowerCase() !== vault.toLowerCase()) {
    throw new Error('Snapshot identity mismatch.');
  }
  const client = await readClient();
  const block = await client.getBlock({blockNumber: BigInt(saved.cutoffBlock)});
  const historicTotal = await client.readContract({address: vault, abi: totalDepositedAbi,
    functionName: 'totalDeposited', blockNumber: BigInt(saved.cutoffBlock)});
  if (block.hash !== saved.cutoffBlockHash || historicTotal.toString() !== saved.totalDeposited) {
    throw new Error('Saved snapshot does not match the recorded block.');
  }
  const currentTotal = await client.readContract({address: vault, abi: totalDepositedAbi, functionName: 'totalDeposited'});
  console.log(JSON.stringify({wallets: saved.depositors.length, cutoffBlock: saved.cutoffBlock,
    cutoffTimestamp: saved.cutoffTimestamp, snapshotVerified: true,
    depositsAfterCutoff: currentTotal !== historicTotal}, null, 2));
  if (currentTotal !== historicTotal) {
    console.log('Deposits exist after the cutoff. Review new depositors for explicit invitations before rollout; the saved list was not changed.');
  }
}

async function snapshot() {
  // Existing files are immutable by default so routine use cannot move the cutoff.
  try {
    await readFile(output);
    throw new Error('Snapshot already exists. Keep the original cutoff and add invitations separately.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const apiKey = await setting('ETHERSCAN_API_KEY');
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is required to verify the complete deposit history.');
  const client = await readClient();
  const block = await client.getBlock({blockTag: 'finalized'});
  if (!block.number || !block.hash || Date.now() / 1000 - Number(block.timestamp) > 3600) {
    throw new Error('RPC returned a missing or stale finalized block.');
  }
  const code = await client.getCode({address: vault, blockNumber: block.number});
  if (!code || code === '0x') throw new Error('Vault code missing at cutoff.');
  console.log(`Reading mainnet deposits through finalized block ${block.number}.`);

  const addresses = new Set();
  const seen = new Set();
  let totalDeposited = 0n;
  let complete = false;
  for (let page = 1; page <= 20; page++) {
    const url = new URL('https://api.etherscan.io/v2/api');
    url.search = new URLSearchParams({chainid: '1', module: 'logs', action: 'getLogs',
      address: vault, fromBlock: '0', toBlock: block.number.toString(),
      topic0: toEventSelector(depositEvent), page: String(page), offset: '1000', apikey: apiKey}).toString();
    const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
    if (!response.ok) throw new Error(`Deposit history HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.result) || (data.status !== '1' && data.message !== 'No records found')) {
      throw new Error('Deposit history request failed or was rate limited.');
    }
    for (const log of data.result) {
      if (log.address.toLowerCase() !== vault.toLowerCase() || BigInt(log.blockNumber) > block.number || log.removed) {
        throw new Error('Unexpected deposit log in history response.');
      }
      const id = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(id)) throw new Error('Duplicate history page; refusing incomplete capture.');
      seen.add(id);
      const {args} = decodeEventLog({abi: [depositEvent], data: log.data, topics: log.topics, strict: true});
      if (args.usdcAmount <= 0n) throw new Error('Invalid zero-value deposit event.');
      addresses.add(getAddress(args.user));
      totalDeposited += args.usdcAmount;
    }
    console.log(`Verified history page ${page}: ${seen.size} deposits, ${addresses.size} wallets.`);
    if (data.result.length < 1000) { complete = true; break; }
  }
  if (!complete) throw new Error('History exceeds bounded pagination; no snapshot written.');
  const onchainTotal = await client.readContract({address: vault, blockNumber: block.number,
    abi: totalDepositedAbi, functionName: 'totalDeposited'});
  if (totalDeposited !== onchainTotal || seen.size === 0) {
    throw new Error('Deposit history does not reconcile with on-chain cumulative deposits.');
  }
  const checkedBlock = await client.getBlock({blockNumber: block.number});
  if (checkedBlock.hash !== block.hash) throw new Error('Cutoff block hash changed during capture.');
  const data = {chainId: mainnet.id, vault, cutoffBlock: Number(block.number), cutoffBlockHash: block.hash,
    cutoffTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), capturedAt: new Date().toISOString(),
    depositCount: seen.size, totalDeposited: totalDeposited.toString(),
    depositors: [...addresses].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))};
  await writeFile(output, `${JSON.stringify(data, null, 2)}\n`, {flag: 'wx'});
  console.log(`Saved ${addresses.size} grandfathered wallets to ${fileURLToPath(output)}.`);
}

(process.argv.includes('--verify') ? verify() : snapshot()).catch(error => {
  // Never print provider errors or request URLs, which can contain credentials.
  const safe = error.constructor === Error ? error.message : error.name || 'Provider request failed';
  console.error(`Snapshot stopped: ${safe}`);
  process.exitCode = 1;
});
