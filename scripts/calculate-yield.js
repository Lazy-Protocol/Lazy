import { createPublicClient, http, formatUnits, createWalletClient } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync, createReadStream, openSync, closeSync, readSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

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

// ============================================
// Configuration
// ============================================

const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';
const OPERATOR_ADDRESS = '0xF466ad87c98f50473Cf4Fe32CdF8db652F9E36D6';
const OPERATOR_SOLANA_ADDRESS = '1AxbVeo57DHrMghgWDL5d25j394LDPdwMLEtHHYTkgU';
const RYSK_MM_ADDRESS = '0x59F4a7a9A33CB62940969CE26e33962f256c1C72';
const RYSK_MARGIN_POOL_ADDRESS = '0x691a5fc3a81a144e36c6C4fBCa1fC82843c80d0d';
const VAULT_ADDRESS = '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';


const ETH_RPC = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

// Entry/exit cost rates for deploying/unwinding capital
const ENTRY_COST_RATE = 0.00055;  // 0.055% on deposits
const EXIT_COST_RATE = 0.00055;   // 0.055% on withdrawals
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const LIGHTER_PENDING_WITHDRAWAL_USDC = parseFloat(process.env.LIGHTER_PENDING_WITHDRAWAL_USDC || '0') || 0;
const RYSK_MARK_CONCURRENCY = parseInt(process.env.RYSK_MARK_CONCURRENCY || '8', 10) || 8;
const MARKET_SNAPSHOT_MAX_SKEW_MS = parseInt(process.env.MARKET_SNAPSHOT_MAX_SKEW_MS || '10000', 10) || 10000;
const MARKET_SNAPSHOT_MAX_AGE_MS = parseInt(process.env.MARKET_SNAPSHOT_MAX_AGE_MS || '30000', 10) || 30000;
const RYSK_MARGIN_POOL_BALANCE_ATTEMPTS = parseInt(process.env.RYSK_MARGIN_POOL_BALANCE_ATTEMPTS || '1', 10) || 1;
const RYSK_MARGIN_POOL_BALANCE_TIMEOUT_MS = parseInt(process.env.RYSK_MARGIN_POOL_BALANCE_TIMEOUT_MS || '6000', 10) || 6000;
const RYSK_LIVE_POSITIONS_RESPONSE_TIMEOUT_MS = parseInt(process.env.RYSK_LIVE_POSITIONS_RESPONSE_TIMEOUT_MS || '10000', 10) || 10000;
const RYSK_LIVE_POSITIONS_TIMEOUT_MS = parseInt(process.env.RYSK_LIVE_POSITIONS_TIMEOUT_MS || '20000', 10) || 20000;
const KINETIQ_QUEUE_MAX_REQUESTS_PER_ADDRESS = parseInt(process.env.KINETIQ_QUEUE_MAX_REQUESTS_PER_ADDRESS || '500', 10) || 500;
const MANUAL_HYPE_ADJUSTMENT = 2500;
const MANUAL_USDC_ADJUSTMENT = -143750;
const MANUAL_ADJUSTMENT_LABEL = '+2500 HYPE / -143750 USDC manual entry';

// Token addresses
const TOKENS = {
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  },
  hyperevm: {
    USDC: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 },
    WHYPE: { address: '0x5555555555555555555555555555555555555555', decimals: 18 },
    KHYPE: { address: '0xfD739d4e423301CE9385c1fb8850539D657C296D', decimals: 18 },
    STHYPE: { address: '0xfFaa4a3D97fE9107Cef8a3F48c069F577Ff76cC1', decimals: 18 },
    WSTHYPE: { address: '0x94e8396e0869c9F2200760aF0621aFd240E1CF38', decimals: 18 },
    LHYPE: { address: '0x5748ae796AE46A4F1348a1693de4b50560485562', decimals: 18 },
    USDT0: { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },
    USDH: { address: '0x111111a1a0667d36bd57c0a9f569b98057111111', decimals: 6 },
  },
};

// Stablecoin symbols (always valued at $1)
const STABLECOINS = ['USDC', 'USDT', 'USDT0', 'USDH', 'DAI'];
const KINETIQ_STAKING_MANAGER = '0x393D0B87Ed38fc779FD9611144aE649BA6082109';


// ============================================
// Clients
// ============================================

const ethClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC),
});

const hyperEvmClient = createPublicClient({
  chain: {
    id: 999,
    name: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [HYPEREVM_RPC] } },
  },
  transport: http(HYPEREVM_RPC),
});

// ============================================
// ABIs
// ============================================

const erc20Abi = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const vaultAbi = [
  {
    name: 'sharePrice',
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
    name: 'totalAssets',
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
    name: 'totalDeposited',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalWithdrawn',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

const kinetiqStakingManagerAbi = [
  {
    name: 'nextWithdrawalId',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'withdrawalRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'requestId', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'hypeAmount', type: 'uint256' },
          { name: 'kHYPEAmount', type: 'uint256' },
          { name: 'fee', type: 'uint256' },
          { name: 'bufferUsed', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
    ],
  },
];


// ============================================
// Price Helpers
// ============================================

// Build entry price map from Lighter positions (for hedged assets)
function buildEntryPrices(lighterPositions) {
  const prices = {};
  for (const pos of lighterPositions) {
    if (pos.side === 'short') {
      prices[pos.market] = parseFloat(pos.entryPrice);
    }
  }
  for (const pos of lighterPositions) {
    if (prices[pos.market] === undefined) {
      prices[pos.market] = parseFloat(pos.entryPrice);
    }
  }
  return prices;
}

// ============================================
// Hedged Exposure Calculator
// ============================================

function calculateHedgedExposure({ symbol, totalHoldings, shorts, longs = [], currentPrice }) {
  const totalShort = shorts.reduce((sum, s) => sum + s.size, 0);
  const totalLong = longs.reduce((sum, l) => sum + l.size, 0);
  const netShort = totalShort - totalLong;
  const netExposure = totalHoldings - netShort;
  const netEntryValue = shorts.reduce((sum, s) => sum + s.size * s.entryPrice, 0)
    - longs.reduce((sum, l) => sum + l.size * l.entryPrice, 0);
  const shortUnrealizedPnl = shorts.reduce((sum, s) => sum + (s.unrealizedPnl || 0), 0);
  const longUnrealizedPnl = longs.reduce((sum, l) => sum + (l.unrealizedPnl || 0), 0);
  const perpUnrealizedPnl = shortUnrealizedPnl + longUnrealizedPnl;
  const currentSpotValue = currentPrice > 0 ? totalHoldings * currentPrice : 0;
  const liquidationValue = currentSpotValue + perpUnrealizedPnl;
  let totalValue = 0;

  console.log(`  Shorts:`);
  for (const s of shorts) {
    if (s.size > 0) {
      console.log(`    ${s.venue}: ${' '.repeat(Math.max(0, 14 - s.venue.length))}${s.size.toFixed(2)} ${symbol} @ $${s.entryPrice.toFixed(4)}`);
    }
  }
  if (totalShort === 0) console.log(`    (none)`);
  console.log(`  Total short:${' '.repeat(Math.max(0, 9 - symbol.length))}${totalShort.toFixed(2)} ${symbol}`);

  if (totalLong > 0) {
    console.log(`  Perp longs:`);
    for (const l of longs) {
      if (l.size > 0) {
        console.log(`    ${l.venue}: ${' '.repeat(Math.max(0, 14 - l.venue.length))}${l.size.toFixed(2)} ${symbol} @ $${l.entryPrice.toFixed(4)}`);
      }
    }
    console.log(`  Net short:${' '.repeat(Math.max(0, 11 - symbol.length))}${netShort.toFixed(2)} ${symbol}`);
  }

  console.log(`  ─────────────────────────`);

  if (netEntryValue !== 0) {
    console.log(`  Entry component:   $${netEntryValue.toFixed(2)}`);
    totalValue += netEntryValue;
  }

  if (netExposure > 0 && currentPrice > 0) {
    const unhedgedValue = netExposure * currentPrice;
    console.log(`  Unhedged (asset):${' '.repeat(Math.max(0, 8 - symbol.length))}${netExposure.toFixed(2)} × $${currentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
    totalValue += unhedgedValue;
  } else if (netExposure < 0 && currentPrice > 0) {
    const unhedgedValue = netExposure * currentPrice;
    console.log(`  Unhedged (DEBT):${' '.repeat(Math.max(0, 9 - symbol.length))}${Math.abs(netExposure).toFixed(2)} × $${currentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
    totalValue += unhedgedValue;
  } else if (netExposure === 0 && netEntryValue !== 0) {
    console.log(`  Perfectly hedged!`);
  } else if (totalHoldings > 0 && currentPrice > 0) {
    totalValue = totalHoldings * currentPrice;
    console.log(`  No hedge - current:  ${totalHoldings.toFixed(4)} × $${currentPrice.toFixed(2)} = $${totalValue.toFixed(2)}`);
  } else if (netExposure !== 0) {
    console.log(`  Unhedged exposure present but no current price available`);
  }

  console.log(`  ─────────────────────────`);
  console.log(`  ${symbol} TOTAL:${' '.repeat(Math.max(0, 11 - symbol.length))}$${totalValue.toFixed(2)}`);
  if (currentPrice > 0 && (totalShort > 0 || totalLong > 0)) {
    const diff = totalValue - liquidationValue;
    console.log(`  ${symbol} check: spot@mark $${currentSpotValue.toFixed(2)} + perp uPnL $${perpUnrealizedPnl.toFixed(2)} = $${liquidationValue.toFixed(2)} (diff $${diff.toFixed(2)})`);
  }

  return {
    totalHoldings,
    totalShort: netShort,
    netExposure,
    totalValue,
    currentPrice,
    currentSpotValue,
    perpUnrealizedPnl,
    liquidationValue,
    netEntryValue,
  };
}

// Helper: extract short position for a coin from Hyperliquid positions array
function findHyperliquidShort(positions, coin) {
  for (const pos of positions) {
    const position = pos.position || pos;
    const c = position.coin || pos.coin;
    if (c === coin) {
      const szi = parseFloat(position.szi || pos.szi || 0);
      if (szi < 0) {
        return {
          size: Math.abs(szi),
          entryPrice: parseFloat(position.entryPx || pos.entryPx || 0),
          unrealizedPnl: parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0),
        };
      }
    }
  }
  return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
}

// Helper: extract long position for a coin from Hyperliquid positions array
function findHyperliquidLong(positions, coin) {
  for (const pos of positions) {
    const position = pos.position || pos;
    const c = position.coin || pos.coin;
    if (c === coin) {
      const szi = parseFloat(position.szi || pos.szi || 0);
      if (szi > 0) {
        return {
          size: Math.abs(szi),
          entryPrice: parseFloat(position.entryPx || pos.entryPx || 0),
          unrealizedPnl: parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0),
        };
      }
    }
  }
  return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
}

// Helper: extract short position for a market from Lighter positions array
function findLighterShort(positions, market) {
  const pos = positions.find(p => p.market === market && p.side === 'short');
  if (!pos) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
  const size = parseFloat(pos.size || 0);
  return {
    size: Math.abs(size),
    entryPrice: parseFloat(pos.entryPrice || 0),
    unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
  };
}

// Helper: extract long position for a market from Lighter positions array
function findLighterLong(positions, market) {
  const pos = positions.find(p => p.market === market && p.side === 'long');
  if (!pos) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
  const size = parseFloat(pos.size || 0);
  return {
    size: Math.abs(size),
    entryPrice: parseFloat(pos.entryPrice || 0),
    unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
  };
}

// Helper: derive current price from a short position's entry and PnL
function derivePriceFromShort(short) {
  if (short.size > 0 && short.entryPrice > 0) {
    return short.entryPrice - (short.unrealizedPnl / short.size);
  }
  return 0;
}

// Helper: derive current price from a long position's entry and PnL
function derivePriceFromLong(long) {
  if (long.size > 0 && long.entryPrice > 0) {
    return long.entryPrice + (long.unrealizedPnl / long.size);
  }
  return 0;
}

function firstPositive(...values) {
  return values.find(v => Number.isFinite(v) && v > 0) || 0;
}

function isHypeLikeSymbol(symbol) {
  return ['HYPE', 'WHYPE', 'KHYPE', 'STHYPE', 'WSTHYPE', 'LHYPE'].includes(symbol);
}

function hypeEquivalentBalance(balance, hypeRates = 1) {
  const amount = parseFloat(balance?.balance ?? balance ?? 0);
  if (!Number.isFinite(amount)) return 0;
  const rates = typeof hypeRates === 'number' ? { KHYPE: hypeRates } : hypeRates;
  const rate = rates?.[balance?.symbol] || 1;
  return amount * rate;
}

// ============================================
// Balance Fetching
// ============================================

async function fetchEthereumBalances(address) {
  const balances = [];

  // Native ETH
  try {
    const ethBalance = await ethClient.getBalance({ address });
    if (ethBalance > 0n) {
      balances.push({
        symbol: 'ETH',
        balance: formatUnits(ethBalance, 18),
        chain: 'ethereum',
      });
    }
  } catch (e) {
    console.warn('Failed to fetch ETH balance:', e.message);
  }

  // ERC20 tokens
  for (const [symbol, token] of Object.entries(TOKENS.ethereum)) {
    try {
      const balance = await ethClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
      if (balance > 0n) {
        balances.push({
          symbol,
          balance: formatUnits(balance, token.decimals),
          chain: 'ethereum',
        });
      }
    } catch (e) {
      console.warn(`Failed to fetch ${symbol} balance:`, e.message);
    }
  }

  return balances;
}

async function fetchHyperEvmBalances(address) {
  const balances = [];

  // Native HYPE
  try {
    const hypeBalance = await hyperEvmClient.getBalance({ address });
    if (hypeBalance > 0n) {
      balances.push({
        symbol: 'HYPE',
        balance: formatUnits(hypeBalance, 18),
        chain: 'hyperevm',
      });
    }
  } catch (e) {
    console.warn('Failed to fetch HYPE balance:', e.message);
  }

  // ERC20 tokens
  for (const [symbol, token] of Object.entries(TOKENS.hyperevm)) {
    try {
      const balance = await hyperEvmClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
      if (balance > 0n) {
        balances.push({
          symbol,
          balance: formatUnits(balance, token.decimals),
          chain: 'hyperevm',
        });
      }
    } catch (e) {
      console.warn(`Failed to fetch ${symbol} on HyperEVM:`, e.message);
    }
  }

  return balances;
}

// ============================================
// Pendle PT Positions
// ============================================

async function fetchPendlePositions(address, usdcPrice = 1.0) {
  try {
    // Fetch user positions
    const posResponse = await fetch(
      `https://api-v2.pendle.finance/core/v1/dashboard/positions/database/${address}`
    );

    if (!posResponse.ok) {
      console.warn('Pendle API error:', posResponse.status);
      return { positions: [], totalUsdc: 0, totalHypeEquivalent: 0 };
    }

    const posData = await posResponse.json();
    const positions = [];
    let totalUsdc = 0;
    let totalHypeEquivalent = 0;

    if (posData?.positions) {
      for (const chainPosition of posData.positions) {
        for (const position of chainPosition.openPositions || []) {
          const ptData = position.pt;
          if (!ptData || parseFloat(ptData.balance) <= 0) continue;

          const marketId = position.marketId;
          const ptBalance = parseFloat(formatUnits(BigInt(ptData.balance), 18));
          const balanceUsd = ptData.valuation || 0;
          const balanceUsdc = balanceUsd / usdcPrice; // Convert USD to USDC
          totalUsdc += balanceUsdc;

          // Fetch market data to get PT price and underlying price
          let hypeEquivalent = 0;
          let ptPrice = 0;
          let underlyingPrice = 0;

          try {
            const marketAddress = marketId.split('-')[1];
            const chainId = marketId.split('-')[0];
            const marketResponse = await fetch(
              `https://api-v2.pendle.finance/core/v1/${chainId}/markets/${marketAddress}`
            );

            if (marketResponse.ok) {
              const marketData = await marketResponse.json();
              // Prices in USD, convert to USDC
              ptPrice = (marketData.pt?.price?.usd || 0) / usdcPrice;
              underlyingPrice = (marketData.accountingAsset?.price?.usd || marketData.underlyingAsset?.price?.usd || 0) / usdcPrice;

              if (ptPrice > 0 && underlyingPrice > 0) {
                // HYPE equivalent = PT balance × (PT price / underlying price)
                // Note: ratio of prices, so USDC conversion cancels out
                hypeEquivalent = ptBalance * (ptPrice / underlyingPrice);
              }
            }
          } catch (e) {
            console.warn('Failed to fetch market data:', e.message);
          }

          totalHypeEquivalent += hypeEquivalent;

          positions.push({
            marketId,
            ptBalance,
            balanceUsdc,
            hypeEquivalent,
            ptPrice,
            underlyingPrice,
          });
        }
      }
    }

    return { positions, totalUsdc, totalHypeEquivalent };
  } catch (e) {
    console.warn('Failed to fetch Pendle positions:', e.message);
    return { positions: [], totalUsdc: 0, totalHypeEquivalent: 0 };
  }
}

// ============================================
// Lighter DEX Positions
// ============================================

const LIGHTER_ACCOUNT_INDEX = process.env.LIGHTER_ACCOUNT_INDEX || '702036';
const LIGHTER_DELTA_NEUTRAL_ACCOUNT_INDEXES = parseIndexList(
  process.env.LIGHTER_DELTA_NEUTRAL_ACCOUNT_INDEXES || process.env.SETTLEMENT_PERP_ACCOUNT_INDEX || ''
);
const LIGHTER_NETTED_ACCOUNT_INDEXES = parseIndexList(process.env.NETTED_PERP_ACCOUNT_INDEX || '');
const LIGHTER_GAMMA_STRATEGY_ACCOUNT_INDEXES = parseIndexList(process.env.GAMMA_STRATEGY_PERP_ACCOUNT_INDEX || '');

// Market index to symbol mapping
const LIGHTER_MARKETS = {
  0: 'ETH',
  1: 'BTC',
  24: 'HYPE',
  120: 'LIT',
};

function parseIndexList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function mergeIndexLists(...lists) {
  return [...new Set(lists.flat().map(String).filter(Boolean))];
}

function emptyLighterEquity() {
  return { collateral: 0, unrealizedPnl: 0, equity: 0, positions: [], accountIndexes: [] };
}

function printLighterBook(label, data) {
  console.log(`  ${label}: equity $${data.equity.toFixed(2)} = collateral $${data.collateral.toFixed(2)} + PnL $${data.unrealizedPnl.toFixed(2)}`);
  if (data.accountIndexes?.length > 0) {
    console.log(`    accounts: ${data.accountIndexes.join(', ')}`);
  }
  for (const pos of data.positions || []) {
    const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
    console.log(`    ${pos.market} ${pos.side.toUpperCase()}: ${pos.size} @ $${pos.entryPrice} (${pnlSign}$${pos.unrealizedPnl.toFixed(2)})`);
  }
}

const NAV_MOVEMENT_COMPONENTS = [
  { label: 'HYPE hedged', keys: ['hypeValue'] },
  { label: 'LIT hedged', keys: ['litValue'] },
  { label: 'ETH exposure', keys: ['ethValue'] },
  { label: 'BTC perp', keys: ['btcValue'] },
  { label: 'USDC total', keys: ['totalUsdcBalance', 'usdcBalance'] },
  { label: 'Lighter DN collateral', keys: ['lighterCollateral'] },
  { label: 'Lighter operator', keys: ['lighterOperatorEquity'] },
  { label: 'Rysk stables', keys: ['ryskStableCollateral'] },
  { label: 'HyperLend non-HYPE', keys: ['hyperLendNonHypeValue'] },
  { label: 'Derive portfolio', keys: ['deriveUsdcBalance'] },
  { label: 'Rysk longs live', keys: ['ryskLongMarkValue'] },
];

function sharedFiniteFields(beforeRow, afterRow, keys) {
  if (!beforeRow || !afterRow) return null;
  for (const key of keys) {
    const before = Number(beforeRow[key]);
    const after = Number(afterRow[key]);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      return { before, after };
    }
  }
  return null;
}

function printNavMovement(lastEntry, currentEntry) {
  const previousNav = Number(lastEntry?.nav);
  const currentNav = Number(currentEntry?.nav);
  if (!Number.isFinite(previousNav) || !Number.isFinite(currentNav)) return;

  const navDelta = currentNav - previousNav;
  let explained = 0;
  console.log('');
  console.log('NAV MOVEMENT VS LAST RUN:');
  console.log(`  Previous NAV: $${previousNav.toFixed(2)} (${lastEntry.timestamp || 'unknown time'})`);
  console.log(`  Current NAV:  $${currentNav.toFixed(2)}`);
  console.log(`  NAV delta:    $${navDelta.toFixed(2)}`);
  console.log('  Component deltas:');

  let printed = 0;
  for (const component of NAV_MOVEMENT_COMPONENTS) {
    const values = sharedFiniteFields(lastEntry, currentEntry, component.keys);
    if (!values) continue;
    const delta = values.after - values.before;
    explained += delta;
    if (Math.abs(delta) < 1) continue;
    const sign = delta >= 0 ? '+' : '';
    console.log(`    ${component.label}: ${sign}$${delta.toFixed(2)}`);
    printed += 1;
  }

  if (printed === 0) {
    console.log('    (no component moved by more than $1)');
  }
  const residual = navDelta - explained;
  if (Math.abs(residual) > 1) {
    const sign = residual >= 0 ? '+' : '';
    console.log(`    Unmapped/residual: ${sign}$${residual.toFixed(2)}`);
  }
  console.log('='.repeat(60));
}

async function fetchLighterEquity(addresses, options = {}) {
  try {
    const includeDefaultAccount = options.includeDefaultAccount !== false;
    const includeAccountIndexes = new Set((options.includeAccountIndexes || []).map(String));
    const excludeAccountIndexes = new Set((options.excludeAccountIndexes || []).map(String));
    const addressList = Array.isArray(addresses) ? addresses : [addresses];
    const discoveredAccounts = new Map();
    const accountIndexes = new Set();

    if (includeDefaultAccount) {
      accountIndexes.add(String(LIGHTER_ACCOUNT_INDEX));
    }

    for (const address of addressList) {
      const accountResponse = await fetch(
        `https://mainnet.zklighter.elliot.ai/api/v1/accountsByL1Address?l1_address=${address}`
      );
      if (!accountResponse.ok) continue;

      const accountData = await accountResponse.json();
      const subAccounts = accountData.sub_accounts || [];

      for (const account of subAccounts) {
        if (account.index) {
          const index = String(account.index);
          discoveredAccounts.set(index, account);
          accountIndexes.add(index);
        }
      }
    }

    for (const accountIndex of includeAccountIndexes) {
      accountIndexes.add(accountIndex);
      if (!discoveredAccounts.has(accountIndex)) {
        try {
          const accountResponse = await fetch(
            `https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=${accountIndex}`
          );
          if (accountResponse.ok) {
            const accountData = await accountResponse.json();
            const account = accountData.accounts?.[0];
            if (account) discoveredAccounts.set(accountIndex, account);
          }
        } catch {}
      }
    }

    for (const accountIndex of excludeAccountIndexes) {
      accountIndexes.delete(accountIndex);
    }

    let totalCollateral = 0;
    for (const accountIndex of accountIndexes) {
      const account = discoveredAccounts.get(accountIndex);
      totalCollateral += parseFloat(account?.collateral || 0);
    }

    let unrealizedPnl = 0;
    const aggregatedPositions = new Map();

    // Fetch positions with unrealized PnL from every Lighter subaccount.
    const positionResponses = await Promise.all(
      [...accountIndexes].map(async (accountIndex) => {
        try {
          const response = await fetch(
            `https://explorer.elliot.ai/api/accounts/${accountIndex}/positions`
          );
          if (!response.ok) return null;
          return await response.json();
        } catch {
          return null;
        }
      })
    );

    for (const positionsData of positionResponses) {
      if (!positionsData) continue;

      for (const [marketIdx, position] of Object.entries(positionsData.positions || {})) {
        const market = LIGHTER_MARKETS[marketIdx] || `Market ${marketIdx}`;
        const pnl = parseFloat(position.pnl || 0);
        const rawSize = parseFloat(position.size || 0);
        const side = position.side;
        const signedSize = side === 'short' ? -Math.abs(rawSize) : Math.abs(rawSize);
        const entryPrice = parseFloat(position.entry_price || 0);

        unrealizedPnl += pnl;

        const key = `${market}:${side}`;
        const existing = aggregatedPositions.get(key) || {
          market,
          side,
          size: 0,
          weightedNotional: 0,
          unrealizedPnl: 0,
        };
        existing.size += Math.abs(signedSize);
        existing.weightedNotional += Math.abs(signedSize) * entryPrice;
        existing.unrealizedPnl += pnl;
        aggregatedPositions.set(key, existing);
      }
    }

    const positions = [];
    for (const agg of aggregatedPositions.values()) {
      if (agg.size <= 0) continue;
      positions.push({
        market: agg.market,
        side: agg.side,
        size: agg.size,
        entryPrice: agg.weightedNotional / agg.size,
        unrealizedPnl: agg.unrealizedPnl,
      });
    }

    // Total equity = collateral + unrealized PnL
    const totalEquity = totalCollateral + unrealizedPnl;

    return {
      collateral: totalCollateral,
      unrealizedPnl,
      equity: totalEquity,
      positions,
      accountIndexes: [...accountIndexes],
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter equity:', e.message);
    return { collateral: 0, unrealizedPnl: 0, equity: 0, positions: [], accountIndexes: [] };
  }
}

// ============================================
// Lighter Spot Assets
// ============================================

async function fetchLighterSpotAssets() {
  try {
    const response = await fetch(
      `https://explorer.elliot.ai/api/accounts/${LIGHTER_ACCOUNT_INDEX}/assets`
    );

    if (!response.ok) {
      console.warn('Lighter spot assets API error:', response.status);
      return { assets: {}, litBalance: 0 };
    }

    const data = await response.json();
    const assets = data.assets || {};

    // Extract LIT balance (asset_id 2)
    const litAsset = assets['2'] || {};
    const litBalance = parseFloat(litAsset.balance || 0);

    // Extract USDC balance (asset_id 3)
    const usdcAsset = assets['3'] || {};
    const usdcBalance = parseFloat(usdcAsset.balance || 0);

    return {
      assets,
      litBalance,
      usdcBalance,
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter spot assets:', e.message);
    return { assets: {}, litBalance: 0, usdcBalance: 0 };
  }
}

// ============================================
// Lighter Staked LIT
// ============================================

async function fetchLighterStakedLIT() {
  try {
    // 1. Get staking pool index from system config
    const configRes = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/systemConfig');
    if (!configRes.ok) {
      console.warn('Lighter systemConfig API error:', configRes.status);
      return { stakedLIT: 0, principalLIT: 0 };
    }
    const config = await configRes.json();
    const stakingPoolIndex = config.staking_pool_index;

    // 2. Get account shares
    const accountRes = await fetch(
      `https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=${LIGHTER_ACCOUNT_INDEX}`
    );
    if (!accountRes.ok) {
      console.warn('Lighter account API error:', accountRes.status);
      return { stakedLIT: 0, principalLIT: 0 };
    }
    const accountData = await accountRes.json();
    const account = accountData.accounts?.[0];
    if (!account) {
      return { stakedLIT: 0, principalLIT: 0 };
    }

    // Find staking pool shares
    const stakingShare = (account.shares || []).find(
      s => s.public_pool_index === stakingPoolIndex
    );
    if (!stakingShare) {
      return { stakedLIT: 0, principalLIT: 0 };
    }

    // 3. Get pool totals for pro-rata calculation
    const poolRes = await fetch(
      `https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=${stakingPoolIndex}`
    );
    if (!poolRes.ok) {
      console.warn('Lighter staking pool API error:', poolRes.status);
      // Fall back to principal amount
      return {
        stakedLIT: parseFloat(stakingShare.principal_amount || 0),
        principalLIT: parseFloat(stakingShare.principal_amount || 0),
      };
    }
    const poolData = await poolRes.json();
    const pool = poolData.accounts?.[0];

    const litAsset = (pool?.assets || []).find(a => a.symbol === 'LIT');
    const totalPoolLIT = parseFloat(litAsset?.balance || 0);
    const totalShares = pool?.pool_info?.total_shares || 0;

    if (totalShares === 0) {
      return {
        stakedLIT: parseFloat(stakingShare.principal_amount || 0),
        principalLIT: parseFloat(stakingShare.principal_amount || 0),
      };
    }

    // Pro-rata: our_shares / total_shares * total_pool_LIT
    const litPerShare = totalPoolLIT / totalShares;
    const stakedLIT = stakingShare.shares_amount * litPerShare;

    return {
      stakedLIT,
      principalLIT: parseFloat(stakingShare.principal_amount || 0),
      shares: stakingShare.shares_amount,
      pendingUnlocks: account.pending_unlocks || [],
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter staked LIT:', e.message);
    return { stakedLIT: 0, principalLIT: 0 };
  }
}

// ============================================
// Rysk Finance (Options on HyperEVM)
// ============================================

// Rysk V12 uses Opyn Gamma Protocol. Controller manages vaults per user.
const RYSK_CONTROLLER = '0x84d84e481B49B8Bc5a55f17AaF8181c21A29B212';
const USDT0_ADDRESS = '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb';
const HYPEREVM_USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const USDH_ADDRESS = '0x111111a1a0667d36bd57c0a9f569b98057111111';
const WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555';
const KHYPE_ADDRESS = '0xfD739d4e423301CE9385c1fb8850539D657C296D';
const STHYPE_ADDRESS = '0xfFaa4a3D97fE9107Cef8a3F48c069F577Ff76cC1';
const LHYPE_ACCOUNTANT = '0xcE621a3CA6F72706678cFF0572ae8d15e5F001c3';
const KINETIQ_ACCOUNTANT = '0x9209648Ec9D448EF57116B73A2f081835643dc7A';
const KHYPE_TO_HYPE_SELECTOR = '759bc2fc';
const STHYPE_SHARES_TO_BALANCE_SELECTOR = '53735f37';
const LHYPE_RATE_IN_QUOTE_SELECTOR = '1dcbb110';
const ONE_E18 = 10n ** 18n;
const ONE_E24 = 10n ** 24n;

const gammaControllerAbi = [
  {
    inputs: [{ name: '_accountOwner', type: 'address' }],
    name: 'getAccountVaultCounter',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_vaultId', type: 'uint256' },
    ],
    name: 'getVault',
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'shortOtokens', type: 'address[]' },
        { name: 'longOtokens', type: 'address[]' },
        { name: 'collateralAssets', type: 'address[]' },
        { name: 'shortAmounts', type: 'uint256[]' },
        { name: 'longAmounts', type: 'uint256[]' },
        { name: 'collateralAmounts', type: 'uint256[]' },
      ],
    }],
    stateMutability: 'view',
    type: 'function',
  },
];

const otokenAbi = [
  {
    inputs: [],
    name: 'getOtokenDetails',
    outputs: [
      { name: '', type: 'address' }, // collateralAsset
      { name: '', type: 'address' }, // underlyingAsset
      { name: '', type: 'address' }, // strikeAsset
      { name: '', type: 'uint256' }, // strikePrice (8 decimals)
      { name: '', type: 'uint256' }, // expiryTimestamp
      { name: '', type: 'bool' },    // isPut
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

async function fetchRyskPositions(address) {
  try {
    // 1. Get vault count
    const vaultCount = await hyperEvmClient.readContract({
      address: RYSK_CONTROLLER,
      abi: gammaControllerAbi,
      functionName: 'getAccountVaultCounter',
      args: [address],
    });

    const count = Number(vaultCount);
    if (count === 0) {
      return { totalCollateral: 0, positions: [], vaultCount: 0 };
    }

    // 2. Read all vaults in parallel
    const vaultPromises = [];
    for (let i = 1; i <= count; i++) {
      vaultPromises.push(
        hyperEvmClient.readContract({
          address: RYSK_CONTROLLER,
          abi: gammaControllerAbi,
          functionName: 'getVault',
          args: [address, BigInt(i)],
        }).catch(() => null)
      );
    }
    const vaults = await Promise.all(vaultPromises);

    // 3. Collect oToken addresses for detail lookups
    const otokenAddresses = new Set();
    for (const vault of vaults) {
      if (!vault) continue;
      for (const addr of vault.shortOtokens || []) {
        if (addr && addr !== '0x0000000000000000000000000000000000000000') {
          otokenAddresses.add(addr);
        }
      }
    }

    // 4. Fetch oToken details in parallel
    const otokenDetails = {};
    const detailPromises = [...otokenAddresses].map(async (addr) => {
      try {
        const details = await hyperEvmClient.readContract({
          address: addr,
          abi: otokenAbi,
          functionName: 'getOtokenDetails',
        });
        otokenDetails[addr] = {
          collateralAsset: details[0],
          underlyingAsset: details[1],
          strikeAsset: details[2],
          strikePrice: Number(details[3]) / 1e8,
          expiryTimestamp: Number(details[4]),
          isPut: details[5],
        };
      } catch {
        // oToken may be expired/invalid
      }
    });
    await Promise.all(detailPromises);

    // 5. Parse vaults into positions
    const positions = [];
    let totalCollateralUsdt0 = 0;
    let totalCollateralUsdc = 0;
    let totalCollateralUsdh = 0;
    let totalCollateralWhype = 0;
    let totalCollateralKhype = 0;

    const collateralDecimals = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 6;
      if (lower === HYPEREVM_USDC.toLowerCase()) return 6;
      if (lower === USDH_ADDRESS.toLowerCase()) return 6;
      if (lower === WHYPE_ADDRESS.toLowerCase()) return 18;
      if (lower === KHYPE_ADDRESS.toLowerCase()) return 18;
      return 18; // default
    };

    const collateralSymbol = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 'USDT0';
      if (lower === HYPEREVM_USDC.toLowerCase()) return 'USDC';
      if (lower === USDH_ADDRESS.toLowerCase()) return 'USDH';
      if (lower === WHYPE_ADDRESS.toLowerCase()) return 'WHYPE';
      if (lower === KHYPE_ADDRESS.toLowerCase()) return 'KHYPE';
      return 'UNKNOWN';
    };

    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i];
      if (!vault) continue;

      const slotCount = Math.max(
        vault.shortOtokens?.length || 0,
        vault.longOtokens?.length || 0,
        vault.collateralAssets?.length || 0,
        vault.shortAmounts?.length || 0,
        vault.longAmounts?.length || 0,
        vault.collateralAmounts?.length || 0,
      );

      for (let slot = 0; slot < slotCount; slot++) {
        const shortAddr = vault.shortOtokens?.[slot];
        const collateralAddr = vault.collateralAssets?.[slot];
        const collateralRaw = vault.collateralAmounts?.[slot] || 0n;
        const shortAmount = vault.shortAmounts?.[slot] || 0n;

        if (!shortAddr || shortAddr === '0x0000000000000000000000000000000000000000') continue;
        if (collateralRaw === 0n && shortAmount === 0n) continue;

        const decimals = collateralAddr ? collateralDecimals(collateralAddr) : 6;
        const symbol = collateralAddr ? collateralSymbol(collateralAddr) : 'UNKNOWN';
        const collateralAmount = parseFloat(formatUnits(collateralRaw, decimals));
        const contracts = Number(shortAmount) / 1e8;

        const details = otokenDetails[shortAddr];
        const expiry = details ? new Date(details.expiryTimestamp * 1000) : null;
        const underlyingAsset = details?.underlyingAsset || '';
        const underlyingLower = String(underlyingAsset).toLowerCase();
        let underlying = 'UNKNOWN';
        if (underlyingLower) {
          for (const [symbolName, token] of Object.entries(TOKENS.hyperevm)) {
            if (token.address.toLowerCase() === underlyingLower) {
              underlying = symbolName;
              break;
            }
          }
          if (underlying === 'UNKNOWN') {
            for (const [symbolName, token] of Object.entries(TOKENS.ethereum)) {
              if (token.address.toLowerCase() === underlyingLower) {
                underlying = symbolName;
                break;
              }
            }
          }
        }

        if (symbol === 'USDT0') totalCollateralUsdt0 += collateralAmount;
        else if (symbol === 'USDC') totalCollateralUsdc += collateralAmount;
        else if (symbol === 'USDH') totalCollateralUsdh += collateralAmount;
        else if (symbol === 'WHYPE') totalCollateralWhype += collateralAmount;
        else if (symbol === 'KHYPE') totalCollateralKhype += collateralAmount;

        positions.push({
          vaultId: i + 1,
          vaultSlot: slot,
          type: details?.isPut ? 'PUT' : 'CALL',
          strike: details?.strikePrice || 0,
          expiry: expiry ? expiry.toISOString().split('T')[0] : 'unknown',
          underlying,
          contracts,
          collateral: collateralAmount,
          collateralSymbol: symbol,
        });
      }
    }

    return {
      totalCollateralUsdt0,
      totalCollateralUsdc,
      totalCollateralUsdh,
      totalCollateralWhype,
      totalCollateralKhype,
      totalCollateral: totalCollateralUsdt0 + totalCollateralUsdc + totalCollateralUsdh, // USD-denominated portion
      positions,
      vaultCount: count,
    };
  } catch (e) {
    console.warn('Failed to fetch Rysk positions:', e.message);
    return { totalCollateralUsdt0: 0, totalCollateralUsdc: 0, totalCollateralUsdh: 0, totalCollateralWhype: 0, totalCollateralKhype: 0, totalCollateral: 0, positions: [], vaultCount: 0 };
  }
}

async function fetchRyskMarginPoolBalances(address) {
  let lastError = null;
  for (let attempt = 1; attempt <= RYSK_MARGIN_POOL_BALANCE_ATTEMPTS; attempt++) {
    try {
      const py = `
import json
import os
import io
import contextlib
import time
from scripts.arb.v2.rysk_client import RyskMakerClient

account = ${JSON.stringify(address)}
client = RyskMakerClient(env=os.environ.get("RYSK_ENV", "mainnet"))
responses = []

def _on_response(data):
    responses.append(data)

def _decimals_for(asset: str) -> int:
    addr = (asset or "").lower()
    if addr == ${JSON.stringify(USDT0_ADDRESS.toLowerCase())}:
        return 6
    if addr == ${JSON.stringify(HYPEREVM_USDC.toLowerCase())}:
        return 6
    if addr == ${JSON.stringify(USDH_ADDRESS.toLowerCase())}:
        return 6
    if addr == ${JSON.stringify(WHYPE_ADDRESS.toLowerCase())}:
        return 18
    if addr == ${JSON.stringify(KHYPE_ADDRESS.toLowerCase())}:
        return 18
    return 18

try:
    client.on_response(_on_response)
    with contextlib.redirect_stdout(io.StringIO()):
        client.start(subscribe_assets=[])
    client.get_balances(account)
    time.sleep(2.5)
    entries = []
    got_balances = False
    for resp in responses:
        if isinstance(resp, dict) and resp.get("id") == "balances":
            entries = resp.get("result", []) or []
            got_balances = True
            break
    out = {"__got_balances": got_balances}
    for e in entries:
        asset = (e.get("assetAddress") or "").lower()
        raw = int(e.get("balance", "0"))
        dec = _decimals_for(asset)
        bal = raw / (10 ** dec)
        if asset == ${JSON.stringify(USDT0_ADDRESS.toLowerCase())}:
            out["USDT0"] = bal
        elif asset == ${JSON.stringify(HYPEREVM_USDC.toLowerCase())}:
            out["USDC"] = bal
        elif asset == ${JSON.stringify(USDH_ADDRESS.toLowerCase())}:
            out["USDH"] = bal
        elif asset == ${JSON.stringify(WHYPE_ADDRESS.toLowerCase())}:
            out["WHYPE"] = bal
        elif asset == ${JSON.stringify(KHYPE_ADDRESS.toLowerCase())}:
            out["KHYPE"] = bal
    print(json.dumps(out))
finally:
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            client.stop()
    except Exception:
        pass
`;
      const { stdout } = await execFileAsync('/Users/onomeokajevo/AYP/.venv/bin/python3', ['-c', py], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        timeout: RYSK_MARGIN_POOL_BALANCE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      const jsonText = extractJsonObject(stdout);
      if (!jsonText) throw new Error('empty balance response');
      const parsed = JSON.parse(jsonText);
      if (parsed.__got_balances === false) throw new Error('balance response not received');
      return {
        usdt0: num(parsed.USDT0),
        usdc: num(parsed.USDC),
        usdh: num(parsed.USDH),
        whype: num(parsed.WHYPE),
        khype: num(parsed.KHYPE),
      };
    } catch (e) {
      lastError = e;
      if (attempt < RYSK_MARGIN_POOL_BALANCE_ATTEMPTS) {
        console.warn(`Failed to fetch Rysk MarginPool balances for ${address} (attempt ${attempt}/${RYSK_MARGIN_POOL_BALANCE_ATTEMPTS}):`, e.message);
      }
    }
  }
  throw new Error(`Failed to fetch Rysk MarginPool balances for ${address}: ${lastError?.message || 'unknown error'}`);
}

// ============================================
// Rysk LONG valuation (mark-based, via Derive)
// ============================================
// Symmetric counterpart to the existing short-side intrinsic-liability deduction.
// Long oToken balances are queried live from Rysk. The ledger helpers remain below
// for diagnostics, but the yield run must not infer live exposure from local state.
const RYSK_LONG_ACTIVE_PHASES = new Set(['spread_active', 'gap', 'hedging', 'gamma_active']);
const DERIVE_TICKER_URL = 'https://api.lyra.finance/public/get_ticker';

async function fetchLiveRyskLongs(address) {
  const responseTimeout = Math.max(1, RYSK_LIVE_POSITIONS_RESPONSE_TIMEOUT_MS / 1000);
  const py = `
import json
import os
from decimal import Decimal

from scripts.arb.v3.venues.rysk import RyskMakerClient

account = ${JSON.stringify(address)}
response_timeout = ${JSON.stringify(responseTimeout)}
client = RyskMakerClient(env=os.environ.get("RYSK_ENV", "mainnet"))
try:
    client.start([])
    res = client.get_positions(account, response_timeout=response_timeout)
    stderr = res.get("stderr") or ""
    stdout = res.get("stdout") or ""
    if "positions_response_timeout" in stderr:
        raise RuntimeError(stderr)
    data = json.loads(stdout) if stdout else {}
    rows = data.get("result") if isinstance(data, dict) else []
    if not isinstance(rows, list):
        rows = []
    groups = {}
    otoken_rows = 0
    for row in rows:
        if not isinstance(row, dict) or not row.get("isOtoken"):
            continue
        otoken_rows += 1
        balance = Decimal(str(row.get("balance", "0"))) / Decimal(10) ** 18
        if balance <= 0:
            continue
        underlying = str(row.get("underlying") or row.get("assetName") or "").upper()
        if not underlying:
            continue
        strike = Decimal(str(row.get("strike", "0"))) / Decimal(10) ** 18
        expiry = int(row.get("expiry") or 0)
        if expiry <= 0:
            continue
        option_type = "PUT" if row.get("isPut") else "CALL"
        key = f"{underlying}|{option_type}|{strike.normalize()}|{expiry}"
        current = groups.setdefault(key, {
            "underlying": underlying,
            "optionType": option_type,
            "strike": float(strike),
            "expiryMs": expiry * 1000,
            "size": 0.0,
            "assetAddresses": [],
        })
        current["size"] += float(balance)
        asset = row.get("assetAddress")
        if asset and asset not in current["assetAddresses"]:
            current["assetAddresses"].append(asset)
    print(json.dumps({
        "positions": list(groups.values()),
        "rawRows": len(rows),
        "otokenRows": otoken_rows,
        "account": account,
    }, sort_keys=True))
finally:
    try:
        client.stop()
    except Exception:
        pass
`;
  const { stdout } = await execFileAsync('/Users/onomeokajevo/AYP/.venv/bin/python3', ['-c', py], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    timeout: RYSK_LIVE_POSITIONS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const jsonText = extractJsonObject(stdout);
  if (!jsonText) throw new Error(`empty Rysk live positions response for ${address}`);
  const parsed = JSON.parse(jsonText);
  const positions = Array.isArray(parsed.positions) ? parsed.positions : [];
  return {
    positions,
    rawRows: num(parsed.rawRows),
    otokenRows: num(parsed.otokenRows),
    account: parsed.account || address,
  };
}

function buildActiveRyskLongGroups(records) {
  const groups = new Map();
  const nowMs = Date.now();
  for (const r of records) {
    if (!RYSK_LONG_ACTIVE_PHASES.has(r.phase)) continue;
    if (r.rysk_direction !== "we_bought") continue;
    const expMs = new Date(r.expiry).getTime();
    if (!Number.isFinite(expMs)) continue;
    // Skip past-Rysk-expiry legs; their payout flows through MarginPool / wallet balances
    // already counted elsewhere. Crediting mark here would double-count or use a stale price.
    if (expMs <= nowMs) continue;
    const key = `${r.underlying}|${r.option_type}|${r.strike}|${expMs}`;
    if (!groups.has(key)) {
      groups.set(key, {
        underlying: r.underlying,
        optionType: r.option_type,
        strike: parseFloat(r.strike),
        expiryMs: expMs,
        size: 0,
        premiumPaid: 0,
      });
    }
    const g = groups.get(key);
    g.size += parseFloat(r.rysk_size);
    g.premiumPaid += parseFloat(r.rysk_premium) * parseFloat(r.rysk_size);
  }
  return [...groups.values()];
}

function readLineAtOffset(fd, offset) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(8192);
  let position = Number(offset);
  let totalBytes = 0;

  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead <= 0) break;
    const newlineIndex = buffer.indexOf(10, 0);
    if (newlineIndex >= 0 && newlineIndex < bytesRead) {
      chunks.push(Buffer.from(buffer.subarray(0, newlineIndex)));
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
    totalBytes += bytesRead;
    if (totalBytes > 1024 * 1024) throw new Error("Indexed trade record exceeds 1MB");
  }

  return Buffer.concat(chunks).toString("utf8");
}

function loadActiveRyskLongsFromIndex(ledgerPath) {
  const indexPath = join(__dirname, "..", "data", "v3", "trades.index.json");
  if (!existsSync(indexPath)) return null;

  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const records = [];
  const fd = openSync(ledgerPath, "r");
  try {
    for (const [tradeId, offset] of Object.entries(index)) {
      const line = readLineAtOffset(fd, offset);
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!r.trade_id) r.trade_id = tradeId;
        records.push(r);
      } catch {}
    }
  } finally {
    closeSync(fd);
  }

  return buildActiveRyskLongGroups(records);
}

async function scanActiveRyskLongsFromLedger(ledgerPath) {
  const latest = new Map();
  const rl = createInterface({ input: createReadStream(ledgerPath, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const tid = r.trade_id;
    if (!tid) continue;
    const prev = latest.get(tid);
    if (!prev || (r.updated_at || "") >= (prev.updated_at || "")) latest.set(tid, r);
  }
  return buildActiveRyskLongGroups(latest.values());
}

async function loadActiveRyskLongs() {
  const ledgerPath = join(__dirname, "..", "data", "v3", "trades.jsonl");
  if (!existsSync(ledgerPath)) return [];
  try {
    const indexed = loadActiveRyskLongsFromIndex(ledgerPath);
    if (indexed) return indexed;
  } catch (e) {
    console.warn("Failed to load Rysk longs from trades.index.json, scanning ledger:", e.message);
  }
  return await scanActiveRyskLongsFromLedger(ledgerPath);
}


function deriveInstrumentName(underlying, expiryMs, strike, isPut) {
  const yyyymmdd = new Date(expiryMs).toISOString().slice(0, 10).replace(/-/g, '');
  let s = strike.toString();
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return `${underlying}-${yyyymmdd}-${s}-${isPut ? 'P' : 'C'}`;
}

async function fetchDeriveMark(instrument) {
  const ticker = await fetchDeriveTicker(instrument);
  return ticker?.mark ?? null;
}

async function fetchDeriveTicker(instrument) {
  try {
    const resp = await fetch(DERIVE_TICKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (yield-calc)' },
      body: JSON.stringify({ instrument_name: instrument }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    const t = body?.result;
    if (!t) return null;
    let mark = null;
    for (const k of ['mark_price', 'best_ask_price', 'best_bid_price']) {
      const v = parseFloat(t[k] || '0');
      if (v > 0) {
        mark = v;
        break;
      }
    }
    const delta = parseFloat(
      t?.option_pricing?.delta
      ?? t?.greeks?.delta
      ?? t?.delta
      ?? 0
    );
    return {
      mark,
      delta: Number.isFinite(delta) ? delta : 0,
    };
  } catch {}
  return null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function computeOptionIntrinsic(underlying, strike, isPut, size, spot) {
  if (!spot || spot <= 0) return 0;
  const per = isPut ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  return per * size;
}

async function markRyskLongs(groups, deriveMarks = new Map()) {
  if (!groups || groups.length === 0) {
    return { markFetchMs: 0, markedAt: null, derivePositionMarks: 0, tickerMarks: 0 };
  }

  let derivePositionMarks = 0;
  let tickerMarks = 0;
  const missingGroups = [];
  const markStartedAt = Date.now();

  for (const g of groups) {
    const isPut = g.optionType === "PUT";
    const inst = deriveInstrumentName(g.underlying, g.expiryMs, g.strike, isPut);
    g.instrument = inst;
    const deriveMark = deriveMarks.get(inst);
    if (deriveMark && deriveMark > 0) {
      g.mark = deriveMark;
      g.markRef = "derive-position";
      derivePositionMarks += 1;
    } else {
      missingGroups.push(g);
    }
  }

  await mapWithConcurrency(missingGroups, RYSK_MARK_CONCURRENCY, async (g) => {
    const ticker = await fetchDeriveTicker(g.instrument);
    g.mark = ticker?.mark ?? null;
    g.deltaPerContract = ticker?.delta ?? null;
    if (g.mark != null) {
      g.markRef = "derive-ticker";
      tickerMarks += 1;
    }
  });

  const markFinishedAt = Date.now();
  return {
    markFetchMs: markFinishedAt - markStartedAt,
    markedAt: new Date(markFinishedAt).toISOString(),
    markStartedAt,
    markFinishedAt,
    derivePositionMarks,
    tickerMarks,
  };
}

function buildDeriveMarkMap(deriveData) {
  const marks = new Map();
  for (const p of deriveData?.positions || []) {
    if (p.instrument && p.markPrice > 0) marks.set(p.instrument, p.markPrice);
  }
  return marks;
}

// Value live Rysk longs from pre-fetched marks.
// Priority per leg: Derive mark when listed -> intrinsic value at spot.
// This mirrors paired_gamma_pnl.py: a leg without a Derive twin still has
// real economic value (intrinsic), so we never silently zero gamma legs.
function valueRyskLongs(groups, spotPrices, markTiming = {}) {
  if (!groups || groups.length === 0) {
    return { totalValue: 0, positions: [], noDeriveMark: 0, valuedAtIntrinsic: 0, unknown: 0, markFetchMs: markTiming.markFetchMs || 0, markedAt: markTiming.markedAt || null, derivePositionMarks: markTiming.derivePositionMarks || 0, tickerMarks: markTiming.tickerMarks || 0 };
  }

  for (const g of groups) {
    const isPut = g.optionType === "PUT";
    const spot = spotPrices?.[g.underlying];
    g.intrinsic = computeOptionIntrinsic(g.underlying, g.strike, isPut, g.size, spot);
    if (g.mark != null) {
      g.value = g.mark * g.size;
      g.markSource = "derive";
    } else if (spot && spot > 0) {
      g.value = g.intrinsic;
      g.markSource = "intrinsic";
    } else {
      g.value = 0;
      g.markSource = "unknown";
    }
  }
  const totalValue = groups.reduce((sum, g) => sum + g.value, 0);
  const noDeriveMark = groups.filter((g) => g.mark == null).length;
  const valuedAtIntrinsic = groups.filter((g) => g.markSource === "intrinsic").length;
  const unknown = groups.filter((g) => g.markSource === "unknown").length;
  return { totalValue, positions: groups, noDeriveMark, valuedAtIntrinsic, unknown, markFetchMs: markTiming.markFetchMs || 0, markedAt: markTiming.markedAt || null, derivePositionMarks: markTiming.derivePositionMarks || 0, tickerMarks: markTiming.tickerMarks || 0 };
}


function calculateRyskIntrinsicLiability(positions, spotPrices) {
  return positions.reduce((sum, pos) => {
    const spot = spotPrices?.[pos.underlying] || 0;
    if (!spot || spot <= 0) return sum;
    if (pos.type === 'PUT') {
      return sum + Math.max(pos.strike - spot, 0) * pos.contracts;
    }
    if (pos.type === 'CALL') {
      return sum + Math.max(spot - pos.strike, 0) * pos.contracts;
    }
    return sum;
  }, 0);
}

// ============================================
// HyperLend (Aave V3 fork on HyperEVM)
// ============================================

const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';
const HYPERLEND_ORACLE = '0xC9Fb4fbE842d57EAc1dF3e641a281827493A630e';

const hyperlendPoolAbi = [
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getUserAccountData',
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// hToken addresses (balanceOf includes accrued interest)
const HYPERLEND_HTOKENS = {
  WHYPE: { address: '0x0D745EAA9E70bb8B6e2a0317f85F1d536616bD34', decimals: 18, underlying: WHYPE_ADDRESS },
  KHYPE: { address: '0xa55DE93CDE5A34c5521B7584022846829CB74366', decimals: 18, underlying: KHYPE_ADDRESS },
  USDT0: { address: '0x10982ad645D5A112606534d8567418Cf64c14cB5', decimals: 6, underlying: USDT0_ADDRESS },
  USDC: { address: '0x744E4f26ee30213989216E1632D9BE3547C4885b', decimals: 6, underlying: HYPEREVM_USDC },
};

const HYPERLEND_DEBT_TOKENS = {
  WHYPE: { address: '0x747d0d4Ba0a2083651513cd008deb95075683e82', decimals: 18 },
  KHYPE: { address: '0x185697d814330430b8D4B3121fAB9c811B59798D', decimals: 18 },
  USDT0: { address: '0x1EF897622D62335e7FC88Fb0605FbBa28eC0b01d', decimals: 6 },
  USDC: { address: '0xD612513cB3b2C52abCD6d4b338374C09AdA4657d', decimals: 6 },
};

async function fetchKHypeToHypeRate() {
  const data = `0x${KHYPE_TO_HYPE_SELECTOR}${ONE_E18.toString(16).padStart(64, '0')}`;
  try {
    const result = await hyperEvmClient.call({ to: KINETIQ_ACCOUNTANT, data });
    const raw = result?.data ? BigInt(result.data) : 0n;
    const rate = parseFloat(formatUnits(raw, 18));
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch (e) {
    console.warn('Failed to fetch kHYPE/HYPE conversion rate:', e.message);
  }
  return 1;
}

function uintArg(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function addressArg(address) {
  return String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function fetchWstHypeToHypeRate() {
  const data = `0x${STHYPE_SHARES_TO_BALANCE_SELECTOR}${uintArg(ONE_E24)}`;
  try {
    const result = await hyperEvmClient.call({ to: STHYPE_ADDRESS, data });
    const raw = result?.data ? BigInt(result.data) : 0n;
    const rate = parseFloat(formatUnits(raw, 18));
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch (e) {
    console.warn('Failed to fetch wstHYPE/HYPE conversion rate:', e.message);
  }
  return 1;
}

async function fetchLHypeToHypeRate() {
  const data = `0x${LHYPE_RATE_IN_QUOTE_SELECTOR}${addressArg(WHYPE_ADDRESS)}`;
  try {
    const result = await hyperEvmClient.call({ to: LHYPE_ACCOUNTANT, data });
    const raw = result?.data ? BigInt(result.data) : 0n;
    const rate = parseFloat(formatUnits(raw, 18));
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch (e) {
    console.warn('Failed to fetch LHYPE/HYPE conversion rate:', e.message);
  }
  return 1;
}

async function fetchHypeLikeRates() {
  const [khype, wsthype, lhype] = await Promise.all([
    fetchKHypeToHypeRate(),
    fetchWstHypeToHypeRate(),
    fetchLHypeToHypeRate(),
  ]);
  return {
    HYPE: 1,
    WHYPE: 1,
    KHYPE: khype,
    STHYPE: 1,
    WSTHYPE: wsthype,
    LHYPE: lhype,
  };
}

function normalizeWithdrawalRequest(row) {
  const hypeRaw = row?.hypeAmount ?? row?.[0] ?? 0n;
  const khypeRaw = row?.kHYPEAmount ?? row?.[1] ?? 0n;
  const feeRaw = row?.fee ?? row?.[2] ?? 0n;
  const bufferUsedRaw = row?.bufferUsed ?? row?.[3] ?? 0n;
  const timestampRaw = row?.timestamp ?? row?.[4] ?? 0n;
  return {
    hypeAmount: formatUnits(BigInt(hypeRaw || 0n), 18),
    khypeAmount: formatUnits(BigInt(khypeRaw || 0n), 18),
    fee: formatUnits(BigInt(feeRaw || 0n), 18),
    bufferUsed: formatUnits(BigInt(bufferUsedRaw || 0n), 18),
    timestamp: Number(timestampRaw || 0n),
  };
}

async function fetchKinetiqWithdrawalQueue(addresses, hypeRates = {}) {
  const addressList = [...new Set((Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean))];
  const claims = [];
  let truncated = false;

  for (const address of addressList) {
    try {
      const nextId = await hyperEvmClient.readContract({
        address: KINETIQ_STAKING_MANAGER,
        abi: kinetiqStakingManagerAbi,
        functionName: 'nextWithdrawalId',
        args: [address],
      });
      const requestCount = Number(nextId || 0n);
      if (!Number.isFinite(requestCount) || requestCount <= 0) continue;

      const idsToRead = Math.min(requestCount, KINETIQ_QUEUE_MAX_REQUESTS_PER_ADDRESS);
      if (idsToRead < requestCount) truncated = true;
      const startId = requestCount - idsToRead;
      const requests = await Promise.all(
        Array.from({ length: idsToRead }, (_, idx) => {
          const requestId = BigInt(startId + idx);
          return hyperEvmClient.readContract({
            address: KINETIQ_STAKING_MANAGER,
            abi: kinetiqStakingManagerAbi,
            functionName: 'withdrawalRequests',
            args: [address, requestId],
          })
            .then((row) => ({ requestId: startId + idx, row }))
            .catch(() => null);
        })
      );

      for (const request of requests) {
        if (!request) continue;
        const normalized = normalizeWithdrawalRequest(request.row);
        const hypeAmount = parseFloat(normalized.hypeAmount);
        const khypeAmount = parseFloat(normalized.khypeAmount);
        if (normalized.timestamp <= 0 || (hypeAmount <= 0 && khypeAmount <= 0)) continue;
        const hypeEquivalent = hypeAmount > 0 ? hypeAmount : khypeAmount * (hypeRates.KHYPE || 1);
        claims.push({
          address,
          requestId: request.requestId,
          hypeAmount,
          khypeAmount,
          fee: parseFloat(normalized.fee),
          bufferUsed: parseFloat(normalized.bufferUsed),
          timestamp: normalized.timestamp,
          requestedAt: new Date(normalized.timestamp * 1000).toISOString(),
          hypeEquivalent,
        });
      }
    } catch (e) {
      console.warn(`Failed to fetch Kinetiq withdrawal queue for ${address}:`, e.message);
    }
  }

  claims.sort((a, b) => a.timestamp - b.timestamp || a.requestId - b.requestId);
  const totalHypeEquivalent = claims.reduce((sum, claim) => sum + claim.hypeEquivalent, 0);
  const totalKhype = claims.reduce((sum, claim) => sum + claim.khypeAmount, 0);
  const totalFee = claims.reduce((sum, claim) => sum + claim.fee, 0);
  return {
    claims,
    totalHypeEquivalent,
    totalKhype,
    totalFee,
    truncated,
  };
}

async function fetchHyperLendPositions(address) {
  try {
    // Read hToken balances (supplied amounts with interest) and debt tokens in parallel
    const calls = [];
    const callMeta = [];

    for (const [symbol, token] of Object.entries(HYPERLEND_HTOKENS)) {
      calls.push(
        hyperEvmClient.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }).catch(() => 0n)
      );
      callMeta.push({ symbol, type: 'supply', decimals: token.decimals });
    }

    for (const [symbol, token] of Object.entries(HYPERLEND_DEBT_TOKENS)) {
      calls.push(
        hyperEvmClient.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }).catch(() => 0n)
      );
      callMeta.push({ symbol, type: 'debt', decimals: token.decimals });
    }

    // Also get aggregate USD values from Pool
    calls.push(
      hyperEvmClient.readContract({
        address: HYPERLEND_POOL,
        abi: hyperlendPoolAbi,
        functionName: 'getUserAccountData',
        args: [address],
      }).catch(() => null)
    );

    const results = await Promise.all(calls);

    const supplies = {};
    const debts = {};

    for (let i = 0; i < callMeta.length; i++) {
      const meta = callMeta[i];
      const raw = results[i] || 0n;
      const amount = parseFloat(formatUnits(raw, meta.decimals));
      if (amount > 0) {
        if (meta.type === 'supply') {
          supplies[meta.symbol] = amount;
        } else {
          debts[meta.symbol] = amount;
        }
      }
    }

    // Parse aggregate data (prices in 8-decimal USD)
    const accountData = results[results.length - 1];
    const totalCollateralUsd = accountData ? Number(accountData[0]) / 1e8 : 0;
    const totalDebtUsd = accountData ? Number(accountData[1]) / 1e8 : 0;

    return {
      supplies,
      debts,
      totalCollateralUsd,
      totalDebtUsd,
      netValueUsd: totalCollateralUsd - totalDebtUsd,
    };
  } catch (e) {
    console.warn('Failed to fetch HyperLend positions:', e.message);
    return { supplies: {}, debts: {}, totalCollateralUsd: 0, totalDebtUsd: 0, netValueUsd: 0 };
  }
}

// ============================================
// Derive.xyz Options (formerly Lyra v2)
// ============================================

const DERIVE_API = 'https://api.lyra.finance';
const DERIVE_WALLET = process.env.DERIVE_WALLET;
const DERIVE_SESSION_KEY = process.env.DERIVE_SESSION_KEY;
const DERIVE_SUBACCOUNT_ID = process.env.DERIVE_SUBACCOUNT_ID ? parseInt(process.env.DERIVE_SUBACCOUNT_ID) : null;
// Operator wallet's Derive subaccount. Holds collateral + positions that the
// vault session key can read but the main subaccount fetch ignores. Optional;
// when unset the operator side is excluded from NAV.
const DERIVE_OPERATOR_SUBACCOUNT_ID = process.env.DERIVE_OPERATOR_SUBACCOUNT_ID
  ? parseInt(process.env.DERIVE_OPERATOR_SUBACCOUNT_ID)
  : null;

async function deriveAuthHeaders() {
  if (!DERIVE_WALLET || !DERIVE_SESSION_KEY) return null;
  const account = privateKeyToAccount(DERIVE_SESSION_KEY);
  const timestamp = String(Date.now());
  const signature = await account.signMessage({ message: timestamp });
  return {
    'X-LYRAWALLET': DERIVE_WALLET,
    'X-LYRATIMESTAMP': timestamp,
    'X-LYRASIGNATURE': signature,
    'content-type': 'application/json',
  };
}

async function fetchDerivePrivate(method, body, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const headers = await deriveAuthHeaders();
      if (!headers) throw new Error('Derive auth headers unavailable');
      const response = await fetch(`${DERIVE_API}/private/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${method} HTTP ${response.status}`);
      }
      const json = await response.json();
      if (json.error) {
        throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      }
      return json.result || {};
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
      }
    }
  }
  throw lastError;
}

async function fetchDeriveSubaccount(subaccountId) {
  const params = { subaccount_id: subaccountId };
  const [subaccount, collaterals, positionsData, ordersData] = await Promise.all([
    fetchDerivePrivate("get_subaccount", params),
    fetchDerivePrivate("get_collaterals", params),
    fetchDerivePrivate("get_positions", params),
    fetchDerivePrivate("get_open_orders", params),
  ]);
  return { subaccount, collaterals, positionsData, ordersData };
}


async function fetchDerivePositions() {
  if (!DERIVE_WALLET || !DERIVE_SESSION_KEY || !DERIVE_SUBACCOUNT_ID) {
    throw new Error('Derive credentials missing; refusing to calculate NAV without Derive account value');
  }

  const subaccountIds = [DERIVE_SUBACCOUNT_ID];
  if (DERIVE_OPERATOR_SUBACCOUNT_ID && DERIVE_OPERATOR_SUBACCOUNT_ID !== DERIVE_SUBACCOUNT_ID) {
    subaccountIds.push(DERIVE_OPERATOR_SUBACCOUNT_ID);
  }

  try {
    const fetchStartedAt = Date.now();
    const fetched = await Promise.all(subaccountIds.map(fetchDeriveSubaccount));
    const fetchMs = Date.now() - fetchStartedAt;
    const fetchedAt = new Date().toISOString();
    // Aggregate USDC across subaccounts (additive).
    let usdcBalance = 0;
    // Aggregate positions/orders by concatenation; downstream callers iterate them.
    const positions = [];
    const openOrders = [];
    // Aggregate scalar subaccount metrics. accountValue, positionsValue, etc. are
    // additive across subaccounts that the vault is liable for.
    let accountValue = 0;
    let positionsValue = 0;
    let collateralValue = 0;
    let initialMargin = 0;
    let maintenanceMargin = 0;
    let openOrdersMargin = 0;

    for (const { subaccount, collaterals, positionsData, ordersData } of fetched) {

      const collateralList = collaterals.collaterals || [];
      if (Array.isArray(collateralList)) {
        for (const c of collateralList) {
          if (c.asset_name === 'USDC') {
            usdcBalance += parseFloat(c.amount || 0);
          }
        }
      }

      const positionList = positionsData.positions || [];
      if (Array.isArray(positionList)) {
        for (const p of positionList) {
          const amount = parseFloat(p.amount || 0);
          if (amount === 0) continue;
          positions.push({
            instrument: p.instrument_name,
            amount,
            averagePrice: parseFloat(p.average_price || 0),
            markPrice: parseFloat(p.mark_price || 0),
            unrealizedPnl: parseFloat(p.unrealized_pnl || 0),
            indexPrice: parseFloat(p.index_price || 0),
            delta: parseFloat(p.delta || 0),
          });
        }
      }

      const orderList = ordersData.orders || [];
      if (Array.isArray(orderList)) {
        for (const o of orderList) {
          openOrders.push({
            instrument: o.instrument_name,
            direction: o.direction,
            amount: parseFloat(o.amount || 0),
            filledAmount: parseFloat(o.filled_amount || 0),
            limitPrice: parseFloat(o.limit_price || 0),
            status: o.order_status,
          });
        }
      }

      accountValue += parseFloat(subaccount.subaccount_value || 0);
      positionsValue += parseFloat(subaccount.positions_value || 0);
      collateralValue += parseFloat(subaccount.collaterals_value || 0);
      initialMargin += parseFloat(subaccount.initial_margin || 0);
      maintenanceMargin += parseFloat(subaccount.maintenance_margin || 0);
      openOrdersMargin += parseFloat(subaccount.open_orders_margin || 0);
    }

    // Manual fallback value = USDC collateral minus current mark cost to close shorts,
    // plus the mark value of any long positions. USDC includes premiums already
    // received; open shorts are still liabilities.
    const openShortMarkCost = positions
      .filter(p => p.amount < 0)
      .reduce((sum, p) => sum + Math.abs(p.amount) * p.markPrice, 0);
    const openLongMarkValue = positions
      .filter(p => p.amount > 0)
      .reduce((sum, p) => sum + p.amount * p.markPrice, 0);
    const manualPortfolioValue = usdcBalance - openShortMarkCost + openLongMarkValue;
    const portfolioValue = accountValue || manualPortfolioValue;

    return {
      usdcBalance,
      portfolioValue,
      accountValue,
      manualPortfolioValue,
      openShortMarkCost,
      openLongMarkValue,
      positionsValue,
      collateralValue,
      initialMargin,
      maintenanceMargin,
      openOrdersMargin,
      positions,
      openOrders,
      subaccountIds,
      fetchMs,
      fetchedAt,
    };
  } catch (e) {
    throw new Error(`Failed to fetch Derive positions: ${e.message}`);
  }
}

// ============================================
// Hyperliquid L1 Positions
// ============================================

async function fetchHyperliquidEquity(address) {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'clearinghouseState',
        user: address,
      }),
    });

    if (!response.ok) {
      console.warn('Hyperliquid API error:', response.status);
      return { equity: 0, positions: [] };
    }

    const data = await response.json();

    // Extract account equity
    const marginSummary = data.marginSummary || {};
    const equity = parseFloat(marginSummary.accountValue || 0);

    return {
      equity,
      positions: data.assetPositions || [],
    };
  } catch (e) {
    console.warn('Failed to fetch Hyperliquid equity:', e.message);
    return { equity: 0, positions: [] };
  }
}

// Fetch Hyperliquid spot balances
async function fetchHyperliquidSpot(address) {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'spotClearinghouseState',
        user: address,
      }),
    });

    if (!response.ok) {
      console.warn('Hyperliquid spot API error:', response.status);
      return { balances: [], hypeBalance: 0, usdcBalance: 0, usdcTotal: 0, usdcHeld: 0, usdcFree: 0, usdcAvailableAfterMaintenance: 0 };
    }

    const data = await response.json();
    const balances = data.balances || [];

    // Find HYPE balance (token index for HYPE on Hyperliquid spot)
    let hypeBalance = 0;
    let usdcBalance = 0;
    let usdcTotal = 0;
    let usdcHeld = 0;
    let usdcFree = 0;
    let usdcAvailableAfterMaintenance = 0;

    for (const [token, amount] of data.tokenToAvailableAfterMaintenance || []) {
      if (String(token) === '0') {
        usdcAvailableAfterMaintenance = parseFloat(amount || 0) || 0;
      }
    }

    for (const bal of balances) {
      const coin = bal.coin || bal.token;
      if (coin === 'HYPE' || coin === 'PURR') {
        // HYPE might be listed as PURR or HYPE
        if (coin === 'HYPE') {
          hypeBalance = parseFloat(bal.hold || bal.total || 0) + parseFloat(bal.available || 0);
          if (bal.total) hypeBalance = parseFloat(bal.total);
        }
      }

      // Check for USDC
      if (coin === 'USDC' || bal.token === 'USDC') {
        usdcTotal = parseFloat(bal.total || 0) || 0;
        usdcHeld = parseFloat(bal.hold || 0) || 0;
        usdcFree = Math.max(usdcTotal - usdcHeld, 0);
        // In unified margin, hold/free is a withdrawal-state split. NAV uses
        // the full owned spot balance, adjusted later for DN perp PnL.
        usdcBalance = usdcTotal;
      }
    }

    return {
      balances,
      hypeBalance,
      usdcBalance,
      usdcTotal,
      usdcHeld,
      usdcFree,
      usdcAvailableAfterMaintenance,
    };
  } catch (e) {
    console.warn('Failed to fetch Hyperliquid spot:', e.message);
    return { balances: [], hypeBalance: 0, usdcBalance: 0, usdcTotal: 0, usdcHeld: 0, usdcFree: 0, usdcAvailableAfterMaintenance: 0 };
  }
}

// ============================================
// Solana Balance & Staking
// ============================================

// Fetch USDC price in USD (for converting USD prices to USDC terms)
async function fetchUsdcPrice() {
  try {
    const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd');
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      return priceData['usd-coin']?.usd || 1.0;
    }
  } catch (e) {
    console.warn('Failed to fetch USDC price:', e.message);
  }
  return 1.0; // Default to 1:1 if fetch fails
}

async function fetchSolanaData(address, usdcPrice = 1.0) {
  try {
    // Fetch SOL price - try multiple sources for reliability
    let solPrice = 0;

    // Try Jupiter price API first (more reliable, no rate limits)
    try {
      const jupPriceRes = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
      if (jupPriceRes.ok) {
        const jupPriceData = await jupPriceRes.json();
        const solPriceUsd = parseFloat(jupPriceData.data?.['So11111111111111111111111111111111111111112']?.price || 0);
        if (solPriceUsd > 0) {
          solPrice = solPriceUsd / usdcPrice;
        }
      }
    } catch (e) {
      console.warn('Jupiter price API failed:', e.message);
    }

    // Fallback to CoinGecko if Jupiter failed
    if (solPrice === 0) {
      try {
        const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          const solPriceUsd = priceData.solana?.usd || 0;
          solPrice = solPriceUsd / usdcPrice;
        }
      } catch (e) {
        console.warn('CoinGecko price API failed:', e.message);
      }
    }

    // 1. Fetch native SOL balance
    const balanceRes = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
    });

    let solBalance = 0;
    if (balanceRes.ok) {
      const balanceData = await balanceRes.json();
      const lamports = balanceData.result?.value || 0;
      solBalance = lamports / 1e9;
    }

    // 2. Fetch stake accounts
    let stakedSol = 0;
    let stakeAccounts = [];
    try {
      const stakeRes = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'getProgramAccounts',
          params: [
            'Stake11111111111111111111111111111111111111',
            {
              encoding: 'jsonParsed',
              filters: [
                {
                  memcmp: {
                    offset: 12, // Withdraw authority offset
                    bytes: address,
                  },
                },
              ],
            },
          ],
        }),
      });

      if (stakeRes.ok) {
        const stakeData = await stakeRes.json();
        if (stakeData.result) {
          for (const account of stakeData.result) {
            const info = account.account?.data?.parsed?.info;
            if (info?.stake?.delegation) {
              const lamports = parseInt(info.stake.delegation.stake || 0);
              const sol = lamports / 1e9;
              stakedSol += sol;
              stakeAccounts.push({
                pubkey: account.pubkey,
                amount: sol,
                voter: info.stake.delegation.voter,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch stake accounts:', e.message);
    }

    const totalSol = solBalance + stakedSol;
    const solValue = totalSol * solPrice;

    return {
      solBalance,
      stakedSol,
      totalSol,
      solPrice,
      stakeAccounts,
    };
  } catch (e) {
    console.warn('Failed to fetch Solana data:', e.message);
    return {
      solBalance: 0,
      stakedSol: 0,
      totalSol: 0,
      solPrice: 0,
      solValue: 0,
      stakeAccounts: [],
    };
  }
}

// ============================================
// Vault Data
// ============================================

async function fetchVaultData() {
  try {
    const [sharePrice, totalSupply, totalAssets, accumulatedYield, totalDeposited, totalWithdrawn] = await Promise.all([
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'sharePrice',
      }),
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'totalSupply',
      }),
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'totalAssets',
      }),
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'accumulatedYield',
      }),
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'totalDeposited',
      }),
      ethClient.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'totalWithdrawn',
      }),
    ]);

    return {
      sharePrice: parseFloat(formatUnits(sharePrice, 6)),
      totalSupply: parseFloat(formatUnits(totalSupply, 18)),
      totalAssets: parseFloat(formatUnits(totalAssets, 6)),
      accumulatedYield: parseFloat(formatUnits(accumulatedYield, 6)),
      totalDeposited: parseFloat(formatUnits(totalDeposited, 6)),
      totalWithdrawn: parseFloat(formatUnits(totalWithdrawn, 6)),
    };
  } catch (e) {
    console.error('Failed to fetch vault data:', e.message);
    throw e;
  }
}

// ============================================
// Deposit/Withdrawal Volume Tracking (using vault state)
// ============================================

// Uses vault's totalDeposited and totalWithdrawn state variables
// instead of event logs (avoids RPC rate limits)

// ============================================
// NAV History
// ============================================

const NAV_HISTORY_PATH = join(__dirname, '..', 'data', 'nav-history.json');
const YIELD_SNAPSHOTS_PATH = join(__dirname, '..', 'data', 'yield-snapshots.json');
const BACKING_PUBLIC_PATH = join(__dirname, '..', 'frontend', 'public', 'backing.json');

function num(value, defaultValue = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function loadNavHistory() {
  try {
    if (existsSync(NAV_HISTORY_PATH)) {
      return JSON.parse(readFileSync(NAV_HISTORY_PATH, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load NAV history:', e.message);
  }
  return { entries: [] };
}

function saveNavHistory(history) {
  const dir = dirname(NAV_HISTORY_PATH);
  if (!existsSync(dir)) {
    import('fs').then(fs => fs.mkdirSync(dir, { recursive: true }));
  }
  writeFileSync(NAV_HISTORY_PATH, JSON.stringify(history, null, 2));
}

function loadYieldSnapshots() {
  try {
    if (existsSync(YIELD_SNAPSHOTS_PATH)) {
      return JSON.parse(readFileSync(YIELD_SNAPSHOTS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load yield snapshots:', e.message);
  }
  return { snapshots: [] };
}

function saveYieldSnapshot(snapshotData) {
  const snapshots = loadYieldSnapshots();
  snapshots.snapshots.push(snapshotData);
  writeFileSync(YIELD_SNAPSHOTS_PATH, JSON.stringify(snapshots, null, 2));
  console.log(`\nSnapshot saved to ${YIELD_SNAPSHOTS_PATH}`);
}

function parseExpiryFromInstrument(instrument) {
  const m = String(instrument || '').match(/^[A-Z]+-(\d{8})-/);
  if (!m) return null;
  const d = m[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function parseDeriveOptionInstrument(instrument) {
  const m = String(instrument || '').match(/^([A-Z]+)-(\d{8})-(\d+(?:\.\d+)?)-([CP])$/);
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`,
    strike: parseFloat(m[3]),
    isPut: m[4] === 'P',
  };
}

function calculateDeriveIntrinsicAtSpot(positions, spotPrices) {
  let shortLiability = 0;
  let longValue = 0;
  let unknown = 0;

  for (const pos of positions || []) {
    const amount = Number(pos.amount || 0);
    if (amount === 0) continue;
    const parsed = parseDeriveOptionInstrument(pos.instrument);
    const spot = parsed ? spotPrices?.[parsed.underlying] : null;
    if (!parsed || !spot || spot <= 0) {
      unknown += 1;
      continue;
    }

    const intrinsic = computeOptionIntrinsic(parsed.underlying, parsed.strike, parsed.isPut, Math.abs(amount), spot);
    if (amount < 0) shortLiability += intrinsic;
    else longValue += intrinsic;
  }

  return {
    shortLiability,
    longValue,
    netValue: longValue - shortLiability,
    unknown,
  };
}

function derivePositionDelta(pos) {
  const amount = Number(pos.amount || 0);
  const delta = Number(pos.delta || 0);
  if (!amount || !Number.isFinite(delta)) return 0;
  // Derive has returned both per-contract and position-level delta in related
  // payloads. Values inside [-1, 1] are treated as per-contract greeks.
  if (Math.abs(delta) <= 1.000001 && Math.abs(amount) > 1.000001) {
    return amount * delta;
  }
  return delta;
}

function intrinsicOptionDelta(strike, isPut, size, spot) {
  if (!spot || spot <= 0) return 0;
  if (isPut) return spot < strike ? -size : 0;
  return spot > strike ? size : 0;
}

function ryskLongPositionDelta(pos, spotPrices) {
  const size = Number(pos.size || 0);
  if (!size) return 0;
  const perContract = Number(pos.deltaPerContract);
  if (Number.isFinite(perContract) && perContract !== 0) {
    return perContract * size;
  }
  const spot = spotPrices?.[pos.underlying];
  return intrinsicOptionDelta(Number(pos.strike || 0), pos.optionType === 'PUT', size, spot);
}

function calculateHypeOptionDelta(derivePositions, ryskLongMarkData, spotPrices) {
  const deriveRows = (derivePositions || [])
    .filter(pos => parseDeriveOptionInstrument(pos.instrument)?.underlying === 'HYPE');
  const deriveDelta = deriveRows.reduce((sum, pos) => sum + derivePositionDelta(pos), 0);
  const ryskRows = (ryskLongMarkData?.positions || [])
    .filter(pos => pos.underlying === 'HYPE');
  const ryskDelta = ryskRows.reduce((sum, pos) => sum + ryskLongPositionDelta(pos, spotPrices), 0);
  const ryskTickerDeltaRows = ryskRows.filter(pos => Number.isFinite(Number(pos.deltaPerContract)) && Number(pos.deltaPerContract) !== 0).length;
  const ryskIntrinsicDeltaRows = ryskRows.length - ryskTickerDeltaRows;
  return {
    deriveDelta,
    ryskDelta,
    netOptionDelta: deriveDelta + ryskDelta,
    ryskTickerDeltaRows,
    ryskIntrinsicDeltaRows,
  };
}

function formatExpiryFromMs(expiryMs) {
  const date = new Date(expiryMs);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 10);
}

function addOptionBucket(map, expiry, delta) {
  const bucket = map.get(expiry) || {
    expiry,
    deriveShortMark: 0,
    deriveLongMark: 0,
    deriveShortIntrinsic: 0,
    deriveLongIntrinsic: 0,
    ryskLongMark: 0,
    ryskLongIntrinsic: 0,
  };
  for (const [key, value] of Object.entries(delta)) {
    bucket[key] = (bucket[key] || 0) + value;
  }
  map.set(expiry, bucket);
}

function printOptionBookReconciliation(derivePositions, ryskLongMarkData, spotPrices, hedgeBooks = {}) {
  const byExpiry = new Map();
  const deriveByInstrument = new Map();
  const ryskByInstrument = new Map();
  let deriveShortMark = 0;
  let deriveLongMark = 0;
  let deriveShortIntrinsic = 0;
  let deriveLongIntrinsic = 0;

  for (const pos of derivePositions || []) {
    const amount = Number(pos.amount || 0);
    const markPrice = Number(pos.markPrice || 0);
    if (!amount || !Number.isFinite(markPrice)) continue;
    const parsed = parseDeriveOptionInstrument(pos.instrument);
    const spot = parsed ? spotPrices?.[parsed.underlying] : null;
    const intrinsic = parsed && spot
      ? computeOptionIntrinsic(parsed.underlying, parsed.strike, parsed.isPut, Math.abs(amount), spot)
      : 0;
    const markValue = Math.abs(amount) * markPrice;
    const expiry = parsed?.expiry || parseExpiryFromInstrument(pos.instrument) || 'unknown';
    const existing = deriveByInstrument.get(pos.instrument) || {
      instrument: pos.instrument,
      amount: 0,
      shortMark: 0,
      longMark: 0,
      shortIntrinsic: 0,
      longIntrinsic: 0,
    };
    existing.amount += amount;
    if (amount < 0) {
      deriveShortMark += markValue;
      deriveShortIntrinsic += intrinsic;
      existing.shortMark += markValue;
      existing.shortIntrinsic += intrinsic;
      addOptionBucket(byExpiry, expiry, { deriveShortMark: markValue, deriveShortIntrinsic: intrinsic });
    } else {
      deriveLongMark += markValue;
      deriveLongIntrinsic += intrinsic;
      existing.longMark += markValue;
      existing.longIntrinsic += intrinsic;
      addOptionBucket(byExpiry, expiry, { deriveLongMark: markValue, deriveLongIntrinsic: intrinsic });
    }
    deriveByInstrument.set(pos.instrument, existing);
  }

  for (const pos of ryskLongMarkData?.positions || []) {
    const instrument = pos.instrument || deriveInstrumentName(pos.underlying, pos.expiryMs, pos.strike, pos.optionType === 'PUT');
    const expiry = formatExpiryFromMs(pos.expiryMs);
    const existing = ryskByInstrument.get(instrument) || {
      instrument,
      size: 0,
      mark: 0,
      intrinsic: 0,
      markSource: pos.markSource || '',
    };
    existing.size += Number(pos.size || 0);
    existing.mark += Number(pos.value || 0);
    existing.intrinsic += Number(pos.intrinsic || 0);
    if (!existing.markSource && pos.markSource) existing.markSource = pos.markSource;
    ryskByInstrument.set(instrument, existing);
    addOptionBucket(byExpiry, expiry, {
      ryskLongMark: Number(pos.value || 0),
      ryskLongIntrinsic: Number(pos.intrinsic || 0),
    });
  }

  const ryskLongMark = [...ryskByInstrument.values()].reduce((sum, row) => sum + row.mark, 0);
  const ryskLongIntrinsic = [...ryskByInstrument.values()].reduce((sum, row) => sum + row.intrinsic, 0);
  const netOptionMark = -deriveShortMark + deriveLongMark + ryskLongMark;
  const netOptionIntrinsic = -deriveShortIntrinsic + deriveLongIntrinsic + ryskLongIntrinsic;
  const nettedPerpPnl = Number(hedgeBooks.netted?.unrealizedPnl || 0);
  const gammaPerpPnl = Number(hedgeBooks.gamma?.unrealizedPnl || 0);
  const hedgePerpPnl = nettedPerpPnl + gammaPerpPnl;

  console.log('');
  console.log('OPTION BOOK RECONCILIATION:');
  console.log(`  Derive short mark:       -$${deriveShortMark.toFixed(2)}`);
  if (deriveLongMark > 0) {
    console.log(`  Derive long mark:        +$${deriveLongMark.toFixed(2)}`);
  }
  console.log(`  Rysk long mark:          +$${ryskLongMark.toFixed(2)}`);
  console.log(`  Net option mark:         $${netOptionMark.toFixed(2)} (excluding Derive/Rysk cash collateral)`);
  console.log(`  Net intrinsic @ spot:    $${netOptionIntrinsic.toFixed(2)}`);
  if (nettedPerpPnl !== 0 || gammaPerpPnl !== 0) {
    console.log(`  Netted perp PnL:         ${nettedPerpPnl >= 0 ? '+' : ''}$${nettedPerpPnl.toFixed(2)} (configured netted account)`);
    if (gammaPerpPnl !== 0) {
      console.log(`  Gamma perp PnL:          ${gammaPerpPnl >= 0 ? '+' : ''}$${gammaPerpPnl.toFixed(2)} (configured gamma account)`);
    }
    console.log(`  Option + hedge PnL:      $${(netOptionMark + hedgePerpPnl).toFixed(2)} (diagnostic; NAV already counts Lighter equity)`);
  }
  console.log('  By expiry:');
  for (const bucket of [...byExpiry.values()].sort((a, b) => a.expiry.localeCompare(b.expiry))) {
    const markNet = -bucket.deriveShortMark + bucket.deriveLongMark + bucket.ryskLongMark;
    const intrinsicNet = -bucket.deriveShortIntrinsic + bucket.deriveLongIntrinsic + bucket.ryskLongIntrinsic;
    console.log(`    ${bucket.expiry}: mark $${markNet.toFixed(2)} = Derive short -$${bucket.deriveShortMark.toFixed(2)} + Derive long $${bucket.deriveLongMark.toFixed(2)} + Rysk long $${bucket.ryskLongMark.toFixed(2)}; intrinsic $${intrinsicNet.toFixed(2)}`);
  }

  const unmatchedRysk = [...ryskByInstrument.values()]
    .filter(row => !deriveByInstrument.has(row.instrument))
    .sort((a, b) => Math.abs(b.mark) - Math.abs(a.mark))
    .slice(0, 8);
  const unmatchedDeriveShorts = [...deriveByInstrument.values()]
    .filter(row => row.shortMark > 0 && !ryskByInstrument.has(row.instrument))
    .sort((a, b) => b.shortMark - a.shortMark)
    .slice(0, 8);

  if (unmatchedRysk.length > 0) {
    console.log('  Rysk longs without exact Derive instrument:');
    for (const row of unmatchedRysk) {
      console.log(`    ${row.instrument}: size ${row.size.toFixed(2)}, mark $${row.mark.toFixed(2)}, intrinsic $${row.intrinsic.toFixed(2)} (${row.markSource || 'mark'})`);
    }
  }
  if (unmatchedDeriveShorts.length > 0) {
    console.log('  Derive shorts without exact Rysk long instrument:');
    for (const row of unmatchedDeriveShorts) {
      console.log(`    ${row.instrument}: short ${Math.abs(row.amount).toFixed(2)}, mark -$${row.shortMark.toFixed(2)}, intrinsic -$${row.shortIntrinsic.toFixed(2)}`);
    }
  }
}

function buildBackingSnapshot(result) {
  const h = result.holdings || {};
  const derivePositions = h.derive?.positions || [];

  let deriveShortCount = 0;
  let deriveLongCount = 0;
  const expirySet = new Set();
  for (const pos of derivePositions) {
    const amt = Number(pos.amount || 0);
    if (amt < 0) deriveShortCount++;
    else if (amt > 0) deriveLongCount++;
    const exp = parseExpiryFromInstrument(pos.instrument);
    if (exp) expirySet.add(exp);
  }
  const expiries = Array.from(expirySet).sort();

  return {
    publishedAt: new Date().toISOString(),
    vault: {
      address: VAULT_ADDRESS,
      sharePrice: result.sharePrice,
      totalShares: result.totalSupply,
      totalAssets: result.vaultTotalAssets,
      accumulatedYield: result.accumulatedYield,
    },
    cumulativeFlows: {
      deposited: result.flows.cumulativeDeposited,
      withdrawn: result.flows.cumulativeWithdrawn,
    },
    nav: {
      total: result.nav,
      breakdown: [
        { label: 'Derive (USDC)',         value: result.breakdown.derive },
        { label: 'LIT (hedged)',          value: result.breakdown.lit },
        { label: 'HYPE incl. HyperLend', value: result.breakdown.hype },
        { label: 'Lighter (collateral)',  value: result.breakdown.lighterCollateral },
        { label: 'Lighter operator',      value: result.breakdown.lighterOperator },
        { label: 'Rysk longs (mark)',     value: result.optionBook.ryskLongMark },
        { label: 'Rysk (stables)',        value: result.breakdown.ryskStables },
        { label: 'USDC (idle)',           value: result.breakdown.usdc },
        { label: 'HyperLend stable debt', value: result.breakdown.hyperLend },
        { label: 'ETH exposure',          value: result.breakdown.eth },
        { label: 'BTC perp PnL',          value: result.breakdown.btc },
      ].filter((b) => Number.isFinite(b.value) && Math.abs(b.value) > 0.005),
    },
    exposures: {
      hype: h.hype && {
        totalHoldings: h.hype.totalHoldings,
        kinetiqQueueHype: h.hype.kinetiqQueue?.totalHypeEquivalent || 0,
        totalShort: h.hype.totalShort,
        netExposure: h.hype.netExposure,
        currentPrice: h.hype.currentPrice,
        totalValue: h.hype.totalValue,
      },
      lit: h.lit && {
        totalHoldings: h.lit.totalBalance,
        totalShort: h.lit.totalShort,
        netExposure: h.lit.netExposure,
        currentPrice: h.lit.currentPrice,
        totalValue: h.lit.totalValue,
      },
      eth: h.eth && {
        spot: h.eth.spotEth,
        netExposure: h.eth.netExposure,
        currentPrice: h.eth.currentPrice,
        totalValue: h.eth.totalValue,
      },
      btc: h.btc && {
        netExposure: h.btc.netExposure,
        currentPrice: h.btc.currentPrice,
        totalValue: h.btc.totalValue,
      },
    },
    venues: {
      lighter: h.lighter && {
        collateral: h.lighter.collateral,
        unrealizedPnl: h.lighter.unrealizedPnl,
        positionCount: (h.lighter.positions || []).length,
      },
      lighterOperator: h.lighter?.operatorTrading && {
        equity: h.lighter.operatorTrading.equity,
        unrealizedPnl: h.lighter.operatorTrading.unrealizedPnl,
        positionCount: (h.lighter.operatorTrading.positions || []).length,
      },
      hyperliquid: h.hyperliquid && {
        equity: h.hyperliquid.equity,
        collateral: h.hyperliquid.collateral,
        unrealizedPnl: h.hyperliquid.unrealizedPnl,
        unifiedCash: h.hyperliquid.unifiedCash,
        cashNeutralPerpPnl: h.hyperliquid.cashNeutralPerpPnl,
        nonCashNeutralPerpPnl: h.hyperliquid.nonCashNeutralPerpPnl,
        positionCount: (h.hyperliquid.positions || []).length,
      },
      derive: h.derive && {
        usdcBalance: h.derive.usdcBalance,
        portfolioValue: h.derive.portfolioValue,
        shortCount: deriveShortCount,
        longCount: deriveLongCount,
      },
      rysk: h.rysk && {
        usdcCollateral: h.rysk.totalCollateralUsdc,
        usdt0Collateral: h.rysk.totalCollateralUsdt0,
        vaultCount: h.rysk.vaultCount,
      },
      hyperLend: h.hyperLend && {
        totalCollateralUsd: h.hyperLend.totalCollateralUsd,
        totalDebtUsd: h.hyperLend.totalDebtUsd,
        netValueUsd: h.hyperLend.netValueUsd,
        supplies: h.hyperLend.supplies,
        debts: h.hyperLend.debts,
        stableSupplyUsd: result.breakdown.hyperLendStableSupply,
        stableDebtUsd: result.breakdown.hyperLendStableDebt,
        stableNetUsd: result.breakdown.hyperLend,
        hypeCollateralValueUsd: result.breakdown.hyperLendHypeCollateralValue,
        rawNetValueUsd: result.breakdown.hyperLendRawNet,
      },
      pendle: h.pendle && {
        totalUsd: h.pendle.totalUsd,
        positionCount: (h.pendle.positions || []).length,
      },
    },
    optionBook: {
      currentMtm: result.optionBook.currentMtm,
      intrinsicOnlyGap: result.optionBook.intrinsicOnlyGap,
      optionExtrinsicNet: result.optionBook.optionExtrinsicNet,
      deriveShortMtmCost: result.optionBook.deriveShortMtmCost,
      deriveShortIntrinsicCost: result.optionBook.deriveShortIntrinsicCost,
      ryskLongMark: result.optionBook.ryskLongMark,
      ryskLongIntrinsic: result.optionBook.ryskLongIntrinsic,
      upperBoundIfAllOtm: result.optionBook.upperBoundIfAllOtm,
      deriveShortCount,
      deriveLongCount,
      ryskUnmatchedLegs: result.optionBook.ryskUnmatchedLegs,
      expiries,
    },
  };
}

function publishBackingSnapshot(snapshot) {
  try {
    writeFileSync(BACKING_PUBLIC_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`Backing snapshot published to ${BACKING_PUBLIC_PATH}`);
  } catch (e) {
    console.warn('Failed to publish backing snapshot:', e.message);
    return;
  }
  pushBackingSnapshot();
}

// Publish backing.json to origin/main without touching the current branch.
// The website reads from raw.githubusercontent.com/.../main/.../backing.json,
// so the snapshot must land on main even when the operator works on develop.
// Worktree approach keeps unrelated commits from leaking across branches.
function pushBackingSnapshot() {
  const repoRoot = join(__dirname, '..');
  const rel = 'frontend/public/backing.json';
  const worktreeDir = join(repoRoot, '.git', 'backing-publish-worktree');
  const run = (args, opts = {}) =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'inherit', ...opts });
  const runQuiet = (args, opts = {}) =>
    execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
      .toString().trim();

  try {
    runQuiet(['fetch', 'origin', 'main']);
  } catch (e) {
    console.warn('git fetch origin main failed, skipping auto-publish:', e.message);
    return;
  }

  // Create a detached worktree at origin/main's tip.
  try {
    run(['worktree', 'remove', '--force', worktreeDir], { stdio: 'ignore' });
  } catch {}
  try {
    run(['worktree', 'add', '--detach', worktreeDir, 'origin/main']);
  } catch (e) {
    console.warn('git worktree add failed, skipping auto-publish:', e.message);
    return;
  }

  try {
    // Copy the freshly-written snapshot into the main worktree.
    const src = join(repoRoot, rel);
    const dst = join(worktreeDir, rel);
    writeFileSync(dst, readFileSync(src));

    // Skip if main already has identical content.
    try {
      execFileSync('git', ['diff', '--quiet', '--', rel], {
        cwd: worktreeDir, stdio: ['ignore', 'ignore', 'ignore'],
      });
      console.log('Backing snapshot identical to origin/main, skipping push.');
      return;
    } catch (e) {
      if (e.status !== 1) throw e;
    }

    execFileSync('git', ['add', rel], { cwd: worktreeDir, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', 'Update backing.json snapshot'], {
      cwd: worktreeDir, stdio: 'inherit',
    });
    execFileSync('git', ['push', 'origin', 'HEAD:main'], {
      cwd: worktreeDir, stdio: 'inherit',
    });
    console.log('Backing snapshot pushed to origin/main.');
  } catch (e) {
    console.warn('Auto-publish failed, push manually:', e.message);
  } finally {
    try {
      run(['worktree', 'remove', '--force', worktreeDir], { stdio: 'ignore' });
    } catch {}
  }
}

function promptUser(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}


async function timedFetch(label, fetcher) {
  const startedAt = Date.now();
  const value = await fetcher();
  const finishedAt = Date.now();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.defineProperty(value, "__timing", {
      value: { label, startedAt, finishedAt, ms: finishedAt - startedAt },
      enumerable: false,
      configurable: true,
    });
  }
  return value;
}

function marketTimingFromValue(value) {
  return value?.__timing || null;
}

function marketTimingFromRyskMarks(markTiming) {
  if (!markTiming?.markStartedAt || !markTiming?.markFinishedAt) return null;
  return {
    label: "Rysk long marks",
    startedAt: markTiming.markStartedAt,
    finishedAt: markTiming.markFinishedAt,
    ms: markTiming.markFinishedAt - markTiming.markStartedAt,
  };
}

function buildMarketSnapshotQuality(timings) {
  const validTimings = timings.filter(Boolean);
  if (validTimings.length === 0) {
    return { timings: [], skewMs: 0, ageMs: 0, isStale: false, isWide: false };
  }
  const firstFinishedAt = Math.min(...validTimings.map(t => t.finishedAt));
  const lastFinishedAt = Math.max(...validTimings.map(t => t.finishedAt));
  const skewMs = lastFinishedAt - firstFinishedAt;
  const ageMs = Date.now() - lastFinishedAt;
  return {
    timings: validTimings,
    firstFinishedAt,
    lastFinishedAt,
    skewMs,
    ageMs,
    isWide: skewMs > MARKET_SNAPSHOT_MAX_SKEW_MS,
    isStale: ageMs > MARKET_SNAPSHOT_MAX_AGE_MS,
  };
}

function printMarketSnapshotQuality(quality) {
  if (!quality?.timings?.length) return;
  console.log("Market snapshot skew: " + (quality.skewMs / 1000).toFixed(1) + "s; report age: " + (quality.ageMs / 1000).toFixed(1) + "s");
  if (quality.isWide || quality.isStale) {
    const reasons = [];
    if (quality.isWide) reasons.push("skew > " + (MARKET_SNAPSHOT_MAX_SKEW_MS / 1000).toFixed(0) + "s");
    if (quality.isStale) reasons.push("age > " + (MARKET_SNAPSHOT_MAX_AGE_MS / 1000).toFixed(0) + "s");
    console.log("WARNING: Market snapshot quality degraded (" + reasons.join(", ") + "). Mirrored option/perp legs may be using stale relative prices.");
  }
  const now = Date.now();
  for (const t of quality.timings) {
    console.log("  " + t.label + ": " + (t.ms / 1000).toFixed(1) + "s, finished " + ((now - t.finishedAt) / 1000).toFixed(1) + "s ago");
  }
}

// ============================================
// Main Calculation
// ============================================

async function calculateYield() {
  console.log('='.repeat(60));
  console.log('YIELD CALCULATION (Delta-Neutral)');
  console.log('='.repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  // Load history to get previous state
  const history = loadNavHistory();
  const lastEntry = history.entries[history.entries.length - 1];

  // 1. Fetch USDC price first (for converting USD prices to USDC terms)
  console.log('Fetching data...');
  const usdcPrice = await fetchUsdcPrice();
  console.log(`USDC Price: $${usdcPrice.toFixed(6)} (all values in USDC, not USD)`);
  console.log('');

  // 2. Fetch price-sensitive market data first. Do not start the slow
  // blocking balance helpers until this snapshot is captured, otherwise mirrored
  // Derive/Rysk/Lighter/Hyperliquid legs can be valued from different markets.
  const marketFetchStart = Date.now();
  const ryskLongLegsPromise = timedFetch("Rysk live longs", () => fetchLiveRyskLongs(RYSK_MM_ADDRESS));
  const deriveDataPromise = timedFetch("Derive", () => fetchDerivePositions());
  const lighterDataPromise = timedFetch("Lighter DN", () => fetchLighterEquity(MULTISIG_ADDRESS, {
    includeDefaultAccount: true,
    includeAccountIndexes: LIGHTER_DELTA_NEUTRAL_ACCOUNT_INDEXES,
  }));
  const lighterOperatorDataPromise = timedFetch("Lighter operator", () => fetchLighterEquity(OPERATOR_ADDRESS, {
    includeDefaultAccount: false,
    excludeAccountIndexes: LIGHTER_DELTA_NEUTRAL_ACCOUNT_INDEXES,
  }));
  const lighterNettedBookPromise = timedFetch("Lighter netted book", () => (
    LIGHTER_NETTED_ACCOUNT_INDEXES.length
      ? fetchLighterEquity([], {
        includeDefaultAccount: false,
        includeAccountIndexes: LIGHTER_NETTED_ACCOUNT_INDEXES,
      })
      : emptyLighterEquity()
  ));
  const lighterGammaBookPromise = timedFetch("Lighter gamma book", () => (
    LIGHTER_GAMMA_STRATEGY_ACCOUNT_INDEXES.length
      ? fetchLighterEquity([], {
        includeDefaultAccount: false,
        includeAccountIndexes: LIGHTER_GAMMA_STRATEGY_ACCOUNT_INDEXES,
      })
      : emptyLighterEquity()
  ));
  const lighterOtherBookPromise = timedFetch("Lighter other book", () => fetchLighterEquity(OPERATOR_ADDRESS, {
    includeDefaultAccount: false,
    excludeAccountIndexes: mergeIndexLists(
      LIGHTER_DELTA_NEUTRAL_ACCOUNT_INDEXES,
      LIGHTER_NETTED_ACCOUNT_INDEXES,
      LIGHTER_GAMMA_STRATEGY_ACCOUNT_INDEXES,
    ),
  }));
  const hyperliquidDataPromise = timedFetch("Hyperliquid perp", () => fetchHyperliquidEquity(OPERATOR_ADDRESS));
  const ryskLongMarkTimingPromise = Promise.all([ryskLongLegsPromise, deriveDataPromise])
    .then(([liveLongs, derive]) => markRyskLongs(liveLongs.positions, buildDeriveMarkMap(derive)));

  const [
    lighterData,
    lighterOperatorData,
    lighterNettedBook,
    lighterGammaBook,
    lighterOtherBook,
    hyperliquidData,
    deriveData,
    ryskLiveLongs,
    ryskLongMarkTiming,
  ] = await Promise.all([
    lighterDataPromise,
    lighterOperatorDataPromise,
    lighterNettedBookPromise,
    lighterGammaBookPromise,
    lighterOtherBookPromise,
    hyperliquidDataPromise,
    deriveDataPromise,
    ryskLongLegsPromise,
    ryskLongMarkTimingPromise,
  ]);

  const marketFetchMs = Date.now() - marketFetchStart;
  const marketSnapshotQuality = buildMarketSnapshotQuality([
    marketTimingFromValue(lighterData),
    marketTimingFromValue(lighterOperatorData),
    marketTimingFromValue(lighterNettedBook),
    marketTimingFromValue(lighterGammaBook),
    marketTimingFromValue(lighterOtherBook),
    marketTimingFromValue(hyperliquidData),
    marketTimingFromValue(deriveData),
    marketTimingFromValue(ryskLiveLongs),
    marketTimingFromRyskMarks(ryskLongMarkTiming),
  ]);
  console.log(`Market fetch window: ${(marketFetchMs / 1000).toFixed(1)}s; Derive fetch: ${(deriveData.fetchMs / 1000).toFixed(1)}s; Rysk long marks: ${(ryskLongMarkTiming.markFetchMs / 1000).toFixed(1)}s`);
  printMarketSnapshotQuality(marketSnapshotQuality);
  console.log("");

  // 3. Fetch slower balance/state data after the market snapshot. These values
  // are mostly balances or collateral state rather than fast-moving marks.
  const slowDataFetchStart = Date.now();
  const [
    multisigEthBalances,
    operatorEthBalances,
    multisigHyperBalances,
    operatorHyperBalances,
    ryskMmHyperBalances,
    pendleData,
    lighterSpotData,
    lighterStakedData,
    vaultData,
    hyperliquidSpotData,
    ryskData,
    ryskMmVaultData,
    ryskOperatorMarginPool,
    ryskMmMarginPool,
    hyperLendData,
    hypeRates,
  ] = await Promise.all([
    fetchEthereumBalances(MULTISIG_ADDRESS),
    fetchEthereumBalances(OPERATOR_ADDRESS),
    fetchHyperEvmBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(OPERATOR_ADDRESS),
    fetchHyperEvmBalances(RYSK_MM_ADDRESS),
    fetchPendlePositions(MULTISIG_ADDRESS, usdcPrice),
    fetchLighterSpotAssets(),
    fetchLighterStakedLIT(),
    fetchVaultData(),
    fetchHyperliquidSpot(OPERATOR_ADDRESS),
    fetchRyskPositions(OPERATOR_ADDRESS),
    fetchRyskPositions(RYSK_MM_ADDRESS),
    fetchRyskMarginPoolBalances(OPERATOR_ADDRESS),
    fetchRyskMarginPoolBalances(RYSK_MM_ADDRESS),
    fetchHyperLendPositions(OPERATOR_ADDRESS),
    fetchHypeLikeRates(),
  ]);
  const kHypeToHypeRate = hypeRates.KHYPE || 1;
  const kinetiqQueueData = await fetchKinetiqWithdrawalQueue(
    [MULTISIG_ADDRESS, OPERATOR_ADDRESS, RYSK_MM_ADDRESS],
    hypeRates
  );
  const slowDataFetchMs = Date.now() - slowDataFetchStart;
  console.log(`Slow balance/state fetch: ${(slowDataFetchMs / 1000).toFixed(1)}s`);
  console.log("");

  // Calculate deposit/withdrawal deltas from vault state
  const prevDeposited = lastEntry?.cumulativeDeposited || 0;
  const prevWithdrawn = lastEntry?.cumulativeWithdrawn || 0;
  const newDeposits = Math.max(0, vaultData.totalDeposited - prevDeposited);
  const newWithdrawals = Math.max(0, vaultData.totalWithdrawn - prevWithdrawn);

  // 2. Build entry prices from Lighter positions (for hedged spot valuation)
  const entryPrices = buildEntryPrices(lighterData.positions);

  console.log('');
  console.log('HEDGE ENTRY PRICES (from Lighter):');
  for (const [symbol, price] of Object.entries(entryPrices)) {
    console.log(`  ${symbol}: $${price.toFixed(2)}`);
  }

  // 3. Calculate spot holdings value using entry prices (delta-neutral valuation)
  console.log('');
  console.log('SPOT HOLDINGS (valued at hedge entry prices):');

  let spotTotalUsd = 0;
  const allSpotBalances = [
    ...multisigEthBalances,
    ...operatorEthBalances,
    ...multisigHyperBalances,
    ...operatorHyperBalances,
    ...ryskMmHyperBalances,
  ];

  for (const bal of allSpotBalances) {
    let price;
    let priceSource;

    if (isHypeLikeSymbol(bal.symbol)) {
      // Handled in HYPE exposure analysis.
      continue;
    } else if (STABLECOINS.includes(bal.symbol)) {
      // Stablecoins always $1
      price = 1;
      priceSource = 'stable';
    } else if (entryPrices[bal.symbol]) {
      // Hedged asset - use entry price
      price = entryPrices[bal.symbol];
      priceSource = 'entry';
    } else {
      console.log(`  ${bal.symbol} (${bal.chain}): ${parseFloat(bal.balance).toFixed(4)} - UNHEDGED (skipped)`);
      continue;
    }

    const usdValue = parseFloat(bal.balance) * price;
    spotTotalUsd += usdValue;
    console.log(`  ${bal.symbol} (${bal.chain}): ${parseFloat(bal.balance).toFixed(4)} × $${price.toFixed(2)} (${priceSource}) = $${usdValue.toFixed(2)}`);
  }
  console.log(`  SPOT TOTAL: $${spotTotalUsd.toFixed(2)}`);

  const ryskMmStableBalance = ryskMmHyperBalances
    .filter(b => STABLECOINS.includes(b.symbol))
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  const ryskMmHypeBalance = ryskMmHyperBalances
    .filter(b => isHypeLikeSymbol(b.symbol))
    .reduce((sum, b) => sum + hypeEquivalentBalance(b, hypeRates), 0);
  const ryskMmOtherTrackedValue = ryskMmHyperBalances
    .filter(b => !STABLECOINS.includes(b.symbol) && !isHypeLikeSymbol(b.symbol))
    .reduce((sum, b) => {
      if (entryPrices[b.symbol]) {
        return sum + (parseFloat(b.balance) * entryPrices[b.symbol]);
      }
      return sum;
    }, 0);

  if (ryskMmHyperBalances.length > 0) {
    console.log('');
    console.log('RYSK MM WALLET:');
    console.log(`  Address:           ${RYSK_MM_ADDRESS}`);
    if (ryskMmStableBalance > 0) {
      console.log(`  Stable balances:   $${ryskMmStableBalance.toFixed(2)}`);
    }
    if (ryskMmHypeBalance > 0) {
      console.log(`  HYPE-like:         ${ryskMmHypeBalance.toFixed(4)} HYPE equiv`);
    }
    if (ryskMmOtherTrackedValue > 0) {
      console.log(`  Other tracked val: $${ryskMmOtherTrackedValue.toFixed(2)}`);
    }
  }

  // 4. Calculate HYPE exposure and hedged/unhedged portions
  console.log('');
  console.log('HYPE EXPOSURE ANALYSIS:');

  const spotHypeEvm = allSpotBalances
    .filter(b => isHypeLikeSymbol(b.symbol))
    .reduce((sum, b) => sum + hypeEquivalentBalance(b, hypeRates), 0);
  console.log(`  Spot HYPE (EVM):  ${spotHypeEvm.toFixed(2)} HYPE`);
  const spotKhypeEvm = allSpotBalances
    .filter(b => b.symbol === 'KHYPE')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  if (spotKhypeEvm > 0) {
    console.log(`    includes kHYPE: ${spotKhypeEvm.toFixed(4)} @ ${kHypeToHypeRate.toFixed(6)} = ${(spotKhypeEvm * kHypeToHypeRate).toFixed(4)} HYPE equiv`);
  }
  for (const symbol of ['STHYPE', 'WSTHYPE', 'LHYPE']) {
    const amount = allSpotBalances
      .filter(b => b.symbol === symbol)
      .reduce((sum, b) => sum + parseFloat(b.balance), 0);
    if (amount > 0) {
      const rate = hypeRates[symbol] || 1;
      console.log(`    includes ${symbol}: ${amount.toFixed(4)} @ ${rate.toFixed(6)} = ${(amount * rate).toFixed(4)} HYPE equiv`);
    }
  }

  const spotHypeL1 = hyperliquidSpotData.hypeBalance || 0;
  if (spotHypeL1 > 0) {
    console.log(`  Spot HYPE (HL):   ${spotHypeL1.toFixed(2)} HYPE`);
  }

  const ptHypeEquiv = pendleData.totalHypeEquivalent || 0;
  console.log(`  PT HYPE equiv:    ${ptHypeEquiv.toFixed(2)} HYPE`);

  // HYPE-like collateral locked in Rysk covered calls (still our spot HYPE, hedged by perp short)
  const ryskOperatorWhype = (ryskData.totalCollateralWhype || 0) + (ryskOperatorMarginPool.whype || 0);
  const ryskMmWhype = (ryskMmVaultData.totalCollateralWhype || 0) + (ryskMmMarginPool.whype || 0);
  const ryskOperatorKhype = ((ryskData.totalCollateralKhype || 0) + (ryskOperatorMarginPool.khype || 0)) * kHypeToHypeRate;
  const ryskMmKhype = ((ryskMmVaultData.totalCollateralKhype || 0) + (ryskMmMarginPool.khype || 0)) * kHypeToHypeRate;
  const ryskHypeLike = ryskOperatorWhype + ryskMmWhype + ryskOperatorKhype + ryskMmKhype;
  if (ryskHypeLike > 0) {
    console.log(`  Rysk (locked):    ${ryskHypeLike.toFixed(2)} HYPE`);
  }

  // HYPE-like assets supplied/borrowed on HyperLend, converted to HYPE-equivalent.
  const hyperLendWhypeSupply = hyperLendData.supplies['WHYPE'] || 0;
  const hyperLendKhypeSupply = (hyperLendData.supplies['KHYPE'] || 0) * kHypeToHypeRate;
  const hyperLendWhypeDebt = hyperLendData.debts['WHYPE'] || 0;
  const hyperLendKhypeDebt = (hyperLendData.debts['KHYPE'] || 0) * kHypeToHypeRate;
  const hyperLendHypeSupply = hyperLendWhypeSupply + hyperLendKhypeSupply;
  const hyperLendHypeDebt = hyperLendWhypeDebt + hyperLendKhypeDebt;
  const hyperLendHypeNet = hyperLendHypeSupply - hyperLendHypeDebt;
  const hyperLendStableValue = (hyperLendData.supplies['USDT0'] || 0) + (hyperLendData.supplies['USDC'] || 0);
  const hyperLendDebtValue = Object.entries(hyperLendData.debts)
    .filter(([symbol]) => !isHypeLikeSymbol(symbol))
    .reduce((sum, [, value]) => sum + value, 0);
  const hyperLendNonHypeValue = hyperLendStableValue - hyperLendDebtValue;
  if (hyperLendHypeSupply > 0 || hyperLendHypeDebt > 0) {
    console.log(`  HyperLend net:    ${hyperLendHypeNet.toFixed(2)} HYPE`);
  }
  const kinetiqQueueHype = kinetiqQueueData.totalHypeEquivalent || 0;
  if (kinetiqQueueHype > 0) {
    console.log(`  Kinetiq queue:    ${kinetiqQueueHype.toFixed(2)} HYPE claim (${(kinetiqQueueData.totalKhype || 0).toFixed(4)} kHYPE unstaking)`);
    for (const claim of kinetiqQueueData.claims) {
      console.log(`    ${claim.requestedAt}: ${claim.hypeEquivalent.toFixed(4)} HYPE claim from ${claim.khypeAmount.toFixed(4)} kHYPE (fee ${claim.fee.toFixed(4)})`);
    }
    if (kinetiqQueueData.truncated) {
      console.log(`    WARN: queue scan capped at ${KINETIQ_QUEUE_MAX_REQUESTS_PER_ADDRESS} requests per address`);
    }
  }
  if (MANUAL_HYPE_ADJUSTMENT !== 0) {
    console.log(`  Manual entry:     ${MANUAL_HYPE_ADJUSTMENT.toFixed(2)} HYPE`);
  }

  const totalHypeHoldings = spotHypeEvm + spotHypeL1 + ptHypeEquiv + ryskHypeLike + hyperLendHypeNet + kinetiqQueueHype + MANUAL_HYPE_ADJUSTMENT;
  console.log(`  ─────────────────────────`);
  console.log(`  Total holdings:   ${totalHypeHoldings.toFixed(2)} HYPE`);

  const lighterHypeShort = findLighterShort(lighterData.positions, 'HYPE');
  const lighterHypeLong = findLighterLong(lighterData.positions, 'HYPE');
  const hlHypeShort = findHyperliquidShort(hyperliquidData.positions, 'HYPE');
  let hypeCurrentPrice = firstPositive(
    pendleData.positions[0]?.underlyingPrice,
    derivePriceFromShort(hlHypeShort),
    derivePriceFromShort(lighterHypeShort),
    derivePriceFromLong(lighterHypeLong),
    entryPrices['HYPE'],
  );

  const hypeExposure = calculateHedgedExposure({
    symbol: 'HYPE',
    totalHoldings: totalHypeHoldings,
    shorts: [
      { venue: 'Lighter', ...lighterHypeShort },
      { venue: 'Hyperliquid', ...hlHypeShort },
    ],
    longs: [
      { venue: 'Lighter', ...lighterHypeLong },
    ],
    currentPrice: hypeCurrentPrice,
  });
  const { netExposure, totalValue: totalHypeValue } = hypeExposure;
  const hyperLendHypeCurrentValue = hyperLendHypeNet * hypeCurrentPrice;
  const hypePlusHyperLendNetValue = totalHypeValue + hyperLendNonHypeValue;

  if (hyperLendHypeSupply > 0 || hyperLendHypeDebt > 0 || hyperLendDebtValue > 0 || hyperLendStableValue > 0) {
    console.log('');
    console.log('HYPE / HYPERLEND SETTLEMENT CHECK:');
    console.log(`  HyperLend HYPE net:      ${hyperLendHypeNet.toFixed(4)} HYPE × $${hypeCurrentPrice.toFixed(4)} = $${hyperLendHypeCurrentValue.toFixed(2)}`);
    console.log(`  HyperLend stables net:   $${hyperLendNonHypeValue.toFixed(2)} (supplies $${hyperLendStableValue.toFixed(2)} - debts $${hyperLendDebtValue.toFixed(2)})`);
    console.log(`  Raw HyperLend net @ mark:$${(hyperLendHypeCurrentValue + hyperLendNonHypeValue).toFixed(2)}`);
    console.log(`  HYPE book with hedges:   $${totalHypeValue.toFixed(2)} (spot@mark $${hypeExposure.currentSpotValue.toFixed(2)} + perp uPnL $${hypeExposure.perpUnrealizedPnl.toFixed(2)})`);
    console.log(`  HYPE + stable debt:      $${hypePlusHyperLendNetValue.toFixed(2)}`);
  }

  // 5. Perp positions (collateral only - unrealized PnL offsets spot price changes)
  console.log('');
  console.log('LIGHTER (collateral only - hedged positions):');
  if (lighterData.accountIndexes?.length > 0) {
    console.log(`  Accounts:        ${lighterData.accountIndexes.join(', ')}`);
  }
  console.log(`  Collateral:      $${lighterData.collateral.toFixed(2)}`);
  console.log(`  Unrealized PnL:  $${lighterData.unrealizedPnl.toFixed(2)} (not counted - offsets spot)`);

  if (lighterData.positions.length > 0) {
    console.log('  Positions:');
    for (const pos of lighterData.positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
      console.log(`    ${pos.market} ${pos.side.toUpperCase()}: ${pos.size} @ $${pos.entryPrice} (${pnlSign}$${pos.unrealizedPnl.toFixed(2)})`);
    }
  }

  console.log('');
  console.log('LIGHTER OPERATOR TRADING (standalone, not delta-neutral):');
  if (lighterOperatorData.accountIndexes?.length > 0) {
    console.log(`  Accounts:        ${lighterOperatorData.accountIndexes.join(', ')}`);
  }
  console.log(`  Collateral:      $${lighterOperatorData.collateral.toFixed(2)}`);
  console.log(`  Unrealized PnL:  $${lighterOperatorData.unrealizedPnl.toFixed(2)} (counted in equity)`);
  console.log(`  Equity:          $${lighterOperatorData.equity.toFixed(2)}`);
  if (lighterOperatorData.positions.length > 0) {
    console.log('  Positions:');
    for (const pos of lighterOperatorData.positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
      console.log(`    ${pos.market} ${pos.side.toUpperCase()}: ${pos.size} @ $${pos.entryPrice} (${pnlSign}$${pos.unrealizedPnl.toFixed(2)})`);
    }
  }
  console.log('  Book split (diagnostic only; NAV still uses total line above):');
  printLighterBook('netted', lighterNettedBook);
  printLighterBook('gamma strategy', lighterGammaBook);
  printLighterBook('other operator', lighterOtherBook);
  const lighterSplitEquity = lighterNettedBook.equity + lighterGammaBook.equity + lighterOtherBook.equity;
  const lighterSplitDrift = lighterOperatorData.equity - lighterSplitEquity;
  const lighterOperatorHypeDirectional = lighterOperatorData.positions.reduce((sum, pos) => {
    if (pos.market !== 'HYPE') return sum;
    const size = Number(pos.size || 0);
    return sum + (String(pos.side || '').toLowerCase() === 'long' ? size : -size);
  }, 0);
  if (Math.abs(lighterSplitDrift) > 1) {
    console.log(`  WARN split drift: total operator equity differs from split by $${lighterSplitDrift.toFixed(2)}`);
  }

  // Calculate Hyperliquid total unrealized PnL and collateral
  let hyperliquidTotalUnrealizedPnl = 0;
  if (hyperliquidData.positions.length > 0) {
    for (const pos of hyperliquidData.positions) {
      const position = pos.position || pos;
      const unrealizedPnl = parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0);
      hyperliquidTotalUnrealizedPnl += unrealizedPnl;
    }
  }
  // Collateral = Equity - Unrealized PnL (since equity = collateral + unrealizedPnl)
  const hyperliquidCollateral = hyperliquidData.equity - hyperliquidTotalUnrealizedPnl;

  if (hyperliquidData.equity > 0 || hyperliquidData.positions.length > 0) {
    console.log('');
    console.log('HYPERLIQUID:');
    console.log(`  Equity: $${hyperliquidData.equity.toFixed(2)}`);
    console.log(`  Unrealized PnL: $${hyperliquidTotalUnrealizedPnl.toFixed(2)} (not counted - offsets spot)`);
    console.log(`  Collateral: $${hyperliquidCollateral.toFixed(2)}`);
    if (hyperliquidData.positions.length > 0) {
      console.log('  Positions:');
      for (const pos of hyperliquidData.positions) {
        const position = pos.position || pos;
        const coin = position.coin || pos.coin;
        const szi = parseFloat(position.szi || pos.szi || 0);
        const entryPx = parseFloat(position.entryPx || pos.entryPx || 0);
        const unrealizedPnl = parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0);
        const side = szi >= 0 ? 'LONG' : 'SHORT';
        const size = Math.abs(szi);
        const pnlSign = unrealizedPnl >= 0 ? '+' : '';
        console.log(`    ${coin} ${side}: ${size.toFixed(4)} @ $${entryPx.toFixed(4)} (${pnlSign}$${unrealizedPnl.toFixed(2)})`);
      }
    }
  }

  // Calculate ETH exposure. This catches unhedged/overhedged perp PnL that
  // cannot be safely ignored under the collateral-only perp treatment.
  console.log('');
  console.log('ETH EXPOSURE ANALYSIS:');
  const ethSpot = allSpotBalances
    .filter(b => b.symbol === 'ETH')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  console.log(`  Spot ETH:          ${ethSpot.toFixed(4)} ETH`);

  const lighterEthShort = findLighterShort(lighterData.positions, 'ETH');
  const lighterEthLong = findLighterLong(lighterData.positions, 'ETH');
  const hlEthShort = findHyperliquidShort(hyperliquidData.positions, 'ETH');
  const hlEthLong = findHyperliquidLong(hyperliquidData.positions, 'ETH');
  const currentEthPrice = firstPositive(
    derivePriceFromShort(hlEthShort),
    derivePriceFromLong(hlEthLong),
    derivePriceFromShort(lighterEthShort),
    derivePriceFromLong(lighterEthLong),
    entryPrices['ETH'],
  );

  const ethExposure = calculateHedgedExposure({
    symbol: 'ETH',
    totalHoldings: ethSpot,
    shorts: [
      { venue: 'Lighter', ...lighterEthShort },
      { venue: 'Hyperliquid', ...hlEthShort },
    ],
    longs: [
      { venue: 'Lighter', ...lighterEthLong },
      { venue: 'Hyperliquid', ...hlEthLong },
    ],
    currentPrice: currentEthPrice,
  });
  const ethValue = ethExposure.totalValue;

  // BTC has no spot leg in the vault, but Lighter BTC perp PnL still affects NAV.
  console.log('');
  console.log('BTC PERP EXPOSURE ANALYSIS:');
  const lighterBtcShort = findLighterShort(lighterData.positions, 'BTC');
  const lighterBtcLong = findLighterLong(lighterData.positions, 'BTC');
  const hlBtcShort = findHyperliquidShort(hyperliquidData.positions, 'BTC');
  const hlBtcLong = findHyperliquidLong(hyperliquidData.positions, 'BTC');
  const currentBtcPrice = firstPositive(
    derivePriceFromShort(hlBtcShort),
    derivePriceFromLong(hlBtcLong),
    derivePriceFromShort(lighterBtcShort),
    derivePriceFromLong(lighterBtcLong),
    entryPrices['BTC'],
  );
  const btcExposure = calculateHedgedExposure({
    symbol: 'BTC',
    totalHoldings: 0,
    shorts: [
      { venue: 'Lighter', ...lighterBtcShort },
      { venue: 'Hyperliquid', ...hlBtcShort },
    ],
    longs: [
      { venue: 'Lighter', ...lighterBtcLong },
      { venue: 'Hyperliquid', ...hlBtcLong },
    ],
    currentPrice: currentBtcPrice,
  });
  const btcValue = btcExposure.totalValue;

  // SOL tracking disabled: avoid Solana RPC calls in the yield path.
  const currentSolPrice = 0;
  const solValue = 0;

  // Calculate LIT exposure
  console.log('');
  console.log('LIT EXPOSURE ANALYSIS:');
  const litSpotLighter = lighterSpotData.litBalance;
  console.log(`  Spot (Lighter):      ${litSpotLighter.toFixed(4)} LIT`);

  const stakedLit = lighterStakedData.stakedLIT || 0;
  if (stakedLit > 0) {
    const principalLit = lighterStakedData.principalLIT || 0;
    const stakingRewards = stakedLit - principalLit;
    console.log(`  Staked (Lighter):    ${stakedLit.toFixed(4)} LIT (principal: ${principalLit.toFixed(2)}, rewards: ${stakingRewards >= 0 ? '+' : ''}${stakingRewards.toFixed(2)})`);
  }

  const pendingUnlockLit = (lighterStakedData.pendingUnlocks || [])
    .filter(unlock => Number(unlock.asset_index) === 2)
    .reduce((sum, unlock) => sum + parseFloat(unlock.amount || 0), 0);
  if (pendingUnlockLit > 0) {
    console.log(`  Pending unlock:       ${pendingUnlockLit.toFixed(4)} LIT`);
  }

  const litSpot = litSpotLighter + stakedLit + pendingUnlockLit;
  console.log(`  ─────────────────────────`);
  console.log(`  Total holdings:      ${litSpot.toFixed(4)} LIT`);

  const lighterLitShort = findLighterShort(lighterData.positions, 'LIT');
  const lighterLitLong = findLighterLong(lighterData.positions, 'LIT');
  const hlLitShort = findHyperliquidShort(hyperliquidData.positions, 'LIT');
  const litCurrentPrice = derivePriceFromShort(hlLitShort) || derivePriceFromShort(lighterLitShort);

  const litExposure = calculateHedgedExposure({
    symbol: 'LIT',
    totalHoldings: litSpot,
    shorts: [
      { venue: 'Lighter', ...lighterLitShort },
      { venue: 'Hyperliquid', ...hlLitShort },
    ],
    longs: [
      { venue: 'Lighter', ...lighterLitLong },
    ],
    currentPrice: litCurrentPrice,
  });
  const { netExposure: netLitExposure, totalValue: litValue } = litExposure;

  const ryskLongSpotPrices = {
    HYPE: hypeCurrentPrice,
    BTC: currentBtcPrice,
    ETH: currentEthPrice,
    SOL: currentSolPrice,
    LIT: litCurrentPrice,
  };

  // Rysk Finance (options)
  console.log('');
  console.log('RYSK (Options on HyperEVM):');
  console.log(`  MarginPool:        ${RYSK_MARGIN_POOL_ADDRESS}`);
  const totalRyskVaults = (ryskData.positions.length || 0) + (ryskMmVaultData.positions.length || 0);
  const operatorRyskUsdt0 = (ryskData.totalCollateralUsdt0 || 0) + (ryskOperatorMarginPool.usdt0 || 0);
  const operatorRyskUsdc = (ryskData.totalCollateralUsdc || 0) + (ryskOperatorMarginPool.usdc || 0);
  const operatorRyskUsdh = (ryskData.totalCollateralUsdh || 0) + (ryskOperatorMarginPool.usdh || 0);
  const operatorRyskWhype = (ryskData.totalCollateralWhype || 0) + (ryskOperatorMarginPool.whype || 0);
  const operatorRyskKhype = (ryskData.totalCollateralKhype || 0) + (ryskOperatorMarginPool.khype || 0);
  const mmRyskUsdt0 = (ryskMmVaultData.totalCollateralUsdt0 || 0) + (ryskMmMarginPool.usdt0 || 0);
  const mmRyskUsdc = (ryskMmVaultData.totalCollateralUsdc || 0) + (ryskMmMarginPool.usdc || 0);
  const mmRyskUsdh = (ryskMmVaultData.totalCollateralUsdh || 0) + (ryskMmMarginPool.usdh || 0);
  const mmRyskWhype = (ryskMmVaultData.totalCollateralWhype || 0) + (ryskMmMarginPool.whype || 0);
  const mmRyskKhype = (ryskMmVaultData.totalCollateralKhype || 0) + (ryskMmMarginPool.khype || 0);
  const totalRyskStableCollateral = operatorRyskUsdt0 + operatorRyskUsdc + operatorRyskUsdh + mmRyskUsdt0 + mmRyskUsdc + mmRyskUsdh;
  const totalRyskUsdt0 = operatorRyskUsdt0 + mmRyskUsdt0;
  const totalRyskUsdc = operatorRyskUsdc + mmRyskUsdc;
  const totalRyskUsdh = operatorRyskUsdh + mmRyskUsdh;
  const totalRyskWhype = operatorRyskWhype + mmRyskWhype;
  const totalRyskKhype = operatorRyskKhype + mmRyskKhype;
  const allRyskOptionPositions = [
    ...ryskData.positions,
    ...ryskMmVaultData.positions,
  ];
  const ryskOptionIntrinsicLiability = calculateRyskIntrinsicLiability(allRyskOptionPositions, ryskLongSpotPrices);

  if (totalRyskVaults > 0 || totalRyskStableCollateral > 0 || totalRyskWhype > 0 || totalRyskKhype > 0) {
    if (totalRyskUsdt0 > 0) {
      console.log(`  USDT0 collateral:  $${totalRyskUsdt0.toFixed(2)}`);
    }
    if (totalRyskUsdc > 0) {
      console.log(`  USDC collateral:   $${totalRyskUsdc.toFixed(2)}`);
    }
    if (totalRyskUsdh > 0) {
      console.log(`  USDH collateral:   $${totalRyskUsdh.toFixed(2)}`);
    }
    if (totalRyskWhype > 0) {
      console.log(`  WHYPE collateral:  ${totalRyskWhype.toFixed(4)} HYPE`);
    }
    if (totalRyskKhype > 0) {
      console.log(`  kHYPE collateral:  ${totalRyskKhype.toFixed(4)} @ ${kHypeToHypeRate.toFixed(6)} = ${(totalRyskKhype * kHypeToHypeRate).toFixed(4)} HYPE equiv`);
    }
    console.log(`  Short intrinsic:   -$${ryskOptionIntrinsicLiability.toFixed(2)}`);
    console.log(`  Operator vaults:   ${ryskData.vaultCount}`);
    console.log(`  MM wallet vaults:  ${ryskMmVaultData.vaultCount}`);
    if (operatorRyskUsdt0 > 0 || operatorRyskUsdc > 0 || operatorRyskUsdh > 0 || ryskOperatorMarginPool.whype > 0 || ryskOperatorMarginPool.khype > 0) {
      console.log(`  Operator MarginPool: USDT0=$${ryskOperatorMarginPool.usdt0.toFixed(2)} USDC=$${ryskOperatorMarginPool.usdc.toFixed(2)} USDH=$${ryskOperatorMarginPool.usdh.toFixed(2)} WHYPE=${ryskOperatorMarginPool.whype.toFixed(4)} kHYPE=${ryskOperatorMarginPool.khype.toFixed(4)}`);
    }
    if (mmRyskUsdt0 > 0 || mmRyskUsdc > 0 || mmRyskUsdh > 0 || ryskMmMarginPool.whype > 0 || ryskMmMarginPool.khype > 0) {
      console.log(`  MM MarginPool:      USDT0=$${ryskMmMarginPool.usdt0.toFixed(2)} USDC=$${ryskMmMarginPool.usdc.toFixed(2)} USDH=$${ryskMmMarginPool.usdh.toFixed(2)} WHYPE=${ryskMmMarginPool.whype.toFixed(4)} kHYPE=${ryskMmMarginPool.khype.toFixed(4)}`);
    }
    console.log(`  Positions (${totalRyskVaults} vaults):`);
    for (const pos of ryskData.positions) {
      console.log(`    ${pos.type} $${pos.strike.toFixed(0)} exp ${pos.expiry}: ${pos.contracts.toFixed(1)} contracts (${pos.collateral.toFixed(2)} ${pos.collateralSymbol})`);
    }
    for (const pos of ryskMmVaultData.positions) {
      console.log(`    [MM] ${pos.type} $${pos.strike.toFixed(0)} exp ${pos.expiry}: ${pos.contracts.toFixed(1)} contracts (${pos.collateral.toFixed(2)} ${pos.collateralSymbol})`);
    }
  } else {
    console.log(`  No Rysk positions (${ryskData.vaultCount + ryskMmVaultData.vaultCount} vaults checked)`);
  }

  // HyperLend (Aave V3 fork)
  console.log('');
  console.log('HYPERLEND:');
  if (Object.keys(hyperLendData.supplies).length > 0 || Object.keys(hyperLendData.debts).length > 0) {
    for (const [symbol, amount] of Object.entries(hyperLendData.supplies)) {
      if (isHypeLikeSymbol(symbol)) {
        const hypeEquiv = symbol === 'KHYPE' ? amount * kHypeToHypeRate : amount;
        const rateSuffix = symbol === 'KHYPE' ? ` @ ${kHypeToHypeRate.toFixed(6)}` : '';
        console.log(`  Supplied ${symbol}:    ${amount.toFixed(4)}${rateSuffix} = ${hypeEquiv.toFixed(4)} HYPE equiv`);
      } else {
        console.log(`  Supplied ${symbol}:    $${amount.toFixed(2)}`);
      }
    }
    for (const [symbol, amount] of Object.entries(hyperLendData.debts)) {
      if (isHypeLikeSymbol(symbol)) {
        const hypeEquiv = symbol === 'KHYPE' ? amount * kHypeToHypeRate : amount;
        const rateSuffix = symbol === 'KHYPE' ? ` @ ${kHypeToHypeRate.toFixed(6)}` : '';
        console.log(`  Debt ${symbol}:       -${amount.toFixed(4)}${rateSuffix} = -${hypeEquiv.toFixed(4)} HYPE equiv`);
      } else {
        console.log(`  Debt ${symbol}:       -$${amount.toFixed(2)}`);
      }
    }
  } else {
    console.log('  No HyperLend positions');
  }

  // Derive.xyz (options)
  console.log('');
  console.log('DERIVE (Options):');
  if (deriveData.usdcBalance > 0 || deriveData.positions.length > 0 || deriveData.openOrders.length > 0) {
    console.log(`  USDC balance:      $${deriveData.usdcBalance.toFixed(2)} (max at expiry)`);
    console.log(`  Portfolio value:   $${deriveData.portfolioValue.toFixed(2)} (Derive subaccount value)`);
    if (deriveData.accountValue > 0 && Math.abs(deriveData.accountValue - deriveData.manualPortfolioValue) > 0.01) {
      console.log(`  Manual check:      $${deriveData.manualPortfolioValue.toFixed(2)} (USDC - shorts + longs)`);
    }
    if (deriveData.initialMargin > 0 || deriveData.maintenanceMargin > 0 || deriveData.openOrdersMargin !== 0) {
      console.log(`  Margin:           IM $${deriveData.initialMargin.toFixed(2)} / MM $${deriveData.maintenanceMargin.toFixed(2)} / orders $${Math.abs(deriveData.openOrdersMargin).toFixed(2)}`);
    }
    if (deriveData.positions.length > 0) {
      console.log(`  Open positions:`);
      for (const pos of deriveData.positions) {
        const side = pos.amount < 0 ? 'SHORT' : 'LONG';
        const positionDelta = derivePositionDelta(pos);
        console.log(`    ${pos.instrument} ${side} ${Math.abs(pos.amount)} @ $${pos.averagePrice.toFixed(2)} (mark: $${pos.markPrice.toFixed(2)}, P&L: $${pos.unrealizedPnl.toFixed(2)}, delta: ${positionDelta >= 0 ? '+' : ''}${positionDelta.toFixed(2)})`);
      }
    }
    if (deriveData.openOrders.length > 0) {
      console.log(`  Open orders:`);
      for (const o of deriveData.openOrders) {
        const filled = o.filledAmount > 0 ? ` (${o.filledAmount}/${o.amount} filled)` : '';
        console.log(`    ${o.instrument} ${o.direction} ${o.amount} @ $${o.limitPrice.toFixed(2)}${filled}`);
      }
    }
  } else {
    console.log('  No Derive positions (credentials not set or no activity)');
  }

  // 6. Calculate total NAV
  const ethEntryPrice = entryPrices['ETH'] || 0;

  const usdcBalance = allSpotBalances
    .filter(b => STABLECOINS.includes(b.symbol))
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);

  // Add Lighter spot USDC
  const lighterUsdcBalance = lighterSpotData.usdcBalance || 0;

  // Hyperliquid unified margin: spot USDC is the cash ledger. For DN books
  // whose HL perp PnL is already embedded in entry-price asset valuation,
  // remove that PnL from cash so each leg is counted exactly once.
  const hyperliquidSpotUsdcTotal = hyperliquidSpotData.usdcTotal || hyperliquidSpotData.usdcBalance || 0;
  const hyperliquidSpotUsdcFree = hyperliquidSpotData.usdcFree || 0;
  const hyperliquidCashNeutralPerpPnl =
    (hlHypeShort.unrealizedPnl || 0)
    + (hlLitShort.unrealizedPnl || 0);
  const hyperliquidNonCashNeutralPerpPnl = hyperliquidTotalUnrealizedPnl - hyperliquidCashNeutralPerpPnl;
  const hyperliquidUnifiedCash = hyperliquidSpotUsdcTotal - hyperliquidCashNeutralPerpPnl;
  const hyperliquidUsdcBalance = hyperliquidUnifiedCash;

  const totalUsdcBalance = usdcBalance + lighterUsdcBalance + LIGHTER_PENDING_WITHDRAWAL_USDC + hyperliquidUsdcBalance + MANUAL_USDC_ADJUSTMENT;

  // Rysk stable collateral (USDT0 + USDC + USDH at $1). HYPE-like collateral is counted in HYPE exposure above.
  const ryskStableCollateral = totalRyskStableCollateral - ryskOptionIntrinsicLiability;

  // HyperLend: HYPE-like assets/debts are counted in HYPE exposure. Only add stable supplies/debts here.

  // Derive.xyz: use portfolio value (USDC minus current mark cost of open shorts)
  const deriveUsdcBalance = deriveData.portfolioValue;

  // Rysk longs (live legs). Derive mark when the leg has a listed twin,
  // intrinsic at spot otherwise. Without intrinsic fallback, gamma legs
  // (no Derive counterpart by design) silently zero out and inflate drawdown.
  const ryskLongMarkData = valueRyskLongs(ryskLiveLongs.positions, ryskLongSpotPrices, ryskLongMarkTiming);
  const ryskLongMarkValue = ryskLongMarkData?.totalValue || 0;
  const ryskLongIntrinsicAtSpot = (ryskLongMarkData?.positions || [])
    .reduce((sum, pos) => sum + (pos.intrinsic || 0), 0);
  const deriveIntrinsicAtSpot = calculateDeriveIntrinsicAtSpot(deriveData.positions, ryskLongSpotPrices);
  printOptionBookReconciliation(deriveData.positions, ryskLongMarkData, ryskLongSpotPrices, {
    netted: lighterNettedBook,
    gamma: lighterGammaBook,
  });
  const hypeOptionDelta = calculateHypeOptionDelta(deriveData.positions, ryskLongMarkData, ryskLongSpotPrices);
  const portfolioHypeDirectional = netExposure + lighterOperatorHypeDirectional;
  const portfolioHypeWithOptionDelta = portfolioHypeDirectional + hypeOptionDelta.netOptionDelta;
  console.log('');
  console.log('HYPE DELTA EXPOSURE:');
  console.log(`  Core HYPE book:          ${netExposure.toFixed(2)} HYPE`);
  console.log(`  Lighter operator HYPE:   ${lighterOperatorHypeDirectional >= 0 ? '+' : ''}${lighterOperatorHypeDirectional.toFixed(2)} HYPE`);
  console.log(`  Portfolio directional:   ${portfolioHypeDirectional.toFixed(2)} HYPE ($${(portfolioHypeDirectional * hypeCurrentPrice).toFixed(2)})`);
  console.log(`  Derive option delta:     ${hypeOptionDelta.deriveDelta >= 0 ? '+' : ''}${hypeOptionDelta.deriveDelta.toFixed(2)} HYPE`);
  console.log(`  Rysk long option delta:  ${hypeOptionDelta.ryskDelta >= 0 ? '+' : ''}${hypeOptionDelta.ryskDelta.toFixed(2)} HYPE`);
  console.log(`  Net option delta:        ${hypeOptionDelta.netOptionDelta >= 0 ? '+' : ''}${hypeOptionDelta.netOptionDelta.toFixed(2)} HYPE`);
  console.log(`  All-in spot delta:       ${portfolioHypeWithOptionDelta.toFixed(2)} HYPE ($${(portfolioHypeWithOptionDelta * hypeCurrentPrice).toFixed(2)})`);
  console.log(`  Portfolio HYPE directional exposure incl options: ${portfolioHypeWithOptionDelta.toFixed(2)} HYPE ($${(portfolioHypeWithOptionDelta * hypeCurrentPrice).toFixed(2)})`);
  if (hypeOptionDelta.ryskIntrinsicDeltaRows > 0) {
    console.log(`    (Rysk delta: ${hypeOptionDelta.ryskTickerDeltaRows} ticker-greek legs, ${hypeOptionDelta.ryskIntrinsicDeltaRows} intrinsic-fallback legs)`);
  }

  const totalNav = totalHypeValue + ethValue + btcValue + totalUsdcBalance + lighterData.collateral + lighterOperatorData.equity + litValue + ryskStableCollateral + hyperLendNonHypeValue + deriveUsdcBalance + ryskLongMarkValue;

  console.log('');
  console.log('='.repeat(60));
  console.log('NAV SUMMARY (Delta-Neutral Valuation):');
  console.log(`  HYPE (hedged):    $${totalHypeValue.toFixed(2)}`);
  console.log(`  LIT (hedged):     $${litValue.toFixed(2)}`);
  console.log(`  ETH exposure:     $${ethValue.toFixed(2)}`);
  if (Math.abs(btcValue) > 0.01) {
    console.log(`  BTC perp PnL:     $${btcValue.toFixed(2)}`);
  }
  console.log(`  USDC:             $${totalUsdcBalance.toFixed(2)}`);
  if (lighterUsdcBalance > 0) {
    console.log(`    (incl. Lighter spot: $${lighterUsdcBalance.toFixed(2)})`);
  }
  if (LIGHTER_PENDING_WITHDRAWAL_USDC > 0) {
    console.log(`    (incl. Lighter pending withdrawal: $${LIGHTER_PENDING_WITHDRAWAL_USDC.toFixed(2)})`);
  }
  if (MANUAL_USDC_ADJUSTMENT !== 0) {
    console.log(`    (incl. manual adjustment: $${MANUAL_USDC_ADJUSTMENT.toFixed(2)}; ${MANUAL_ADJUSTMENT_LABEL})`);
  }
  if (hyperliquidUsdcBalance > 0 || (hyperliquidSpotData.usdcTotal || 0) > 0) {
    console.log(`    (incl. Hyperliquid unified cash: $${hyperliquidUsdcBalance.toFixed(2)})`);
    console.log(`      HL spot USDC total=$${hyperliquidSpotUsdcTotal.toFixed(2)} free=$${hyperliquidSpotUsdcFree.toFixed(2)} held margin=$${(hyperliquidSpotData.usdcHeld || 0).toFixed(2)} available-after-maint=$${(hyperliquidSpotData.usdcAvailableAfterMaintenance || 0).toFixed(2)}`);
    console.log(`      HL cash-neutral perp uPnL=$${hyperliquidCashNeutralPerpPnl.toFixed(2)} (HYPE $${(hlHypeShort.unrealizedPnl || 0).toFixed(2)} + LIT $${(hlLitShort.unrealizedPnl || 0).toFixed(2)})`);
    if (Math.abs(hyperliquidNonCashNeutralPerpPnl) > 0.01) {
      console.log(`      HL non-cash-neutral perp uPnL=$${hyperliquidNonCashNeutralPerpPnl.toFixed(2)} (counted in ETH/BTC exposure lines)`);
    }
  }
  console.log(`  Lighter collat:   $${lighterData.collateral.toFixed(2)}`);
  if (lighterOperatorData.equity !== 0) {
    console.log(`  Lighter operator: $${lighterOperatorData.equity.toFixed(2)}`);
  }
  if (hyperliquidCollateral > 0) {
    console.log(`  Hyperliquid col:  $${hyperliquidCollateral.toFixed(2)} (view only, not added)`);
  }
  if (ryskStableCollateral > 0) {
    console.log(`  Rysk (stables):   $${ryskStableCollateral.toFixed(2)}`);
  }
  if (Math.abs(hyperLendNonHypeValue) > 0.01) {
    console.log(`  HyperLend:        $${hyperLendNonHypeValue.toFixed(2)}`);
    if (hyperLendStableValue !== 0 || hyperLendDebtValue !== 0) {
      console.log(`    (stable supplies $${hyperLendStableValue.toFixed(2)} - stable debts $${hyperLendDebtValue.toFixed(2)})`);
    }
  }
  if (deriveUsdcBalance > 0) {
    console.log(`  Derive (USDC):    $${deriveUsdcBalance.toFixed(2)}`);
  }
  if (ryskLongMarkValue !== 0 || ryskLongMarkData?.positions?.length) {
    console.log(`  Rysk longs (live):$${ryskLongMarkValue.toFixed(2)}`);
    console.log(`    (${ryskLongMarkData.positions.length} grouped live legs from ${ryskLiveLongs.otokenRows || 0} oToken rows; marked in ${(ryskLongMarkData.markFetchMs / 1000).toFixed(1)}s with concurrency ${RYSK_MARK_CONCURRENCY}; ${ryskLongMarkData.derivePositionMarks || 0} from Derive positions, ${ryskLongMarkData.tickerMarks || 0} from ticker)`);
    if (ryskLongMarkData?.valuedAtIntrinsic) {
      console.log(`    (${ryskLongMarkData.valuedAtIntrinsic} legs had no Derive mark, valued at intrinsic)`);
    }
    if (ryskLongMarkData?.unknown) {
      console.log(`    (${ryskLongMarkData.unknown} legs had no Derive mark and no spot, valued at $0)`);
    }
  }
  console.log(`  ─────────────────────────`);
  console.log(`  TOTAL NAV:        $${totalNav.toFixed(2)}`);
  console.log('='.repeat(60));

  // 6. Vault state
  console.log('');
  console.log('VAULT STATE:');
  console.log(`  Share Price (PPS):    $${vaultData.sharePrice.toFixed(6)}`);
  console.log(`  Total Shares:         ${vaultData.totalSupply.toFixed(2)}`);
  console.log(`  Vault totalAssets:    $${vaultData.totalAssets.toFixed(2)}`);
  console.log(`  Accumulated Yield:    $${vaultData.accumulatedYield.toFixed(2)}`);

  // 7. Calculate entry/exit costs (socialized)
  const entryCosts = newDeposits * ENTRY_COST_RATE;
  const exitCosts = newWithdrawals * EXIT_COST_RATE;
  const entryExitCosts = entryCosts + exitCosts;
  const totalFlowVolume = newDeposits + newWithdrawals;

  console.log('');
  console.log('='.repeat(60));
  console.log('ENTRY/EXIT COSTS (socialized):');
  console.log(`  New deposits:     $${newDeposits.toFixed(2)} × ${(ENTRY_COST_RATE * 100).toFixed(3)}% = -$${entryCosts.toFixed(2)}`);
  console.log(`  New withdrawals:  $${newWithdrawals.toFixed(2)} × ${(EXIT_COST_RATE * 100).toFixed(3)}% = -$${exitCosts.toFixed(2)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  TOTAL ENTRY/EXIT COSTS: -$${entryExitCosts.toFixed(2)}`);
  console.log(`  (Cumulative: deposited $${vaultData.totalDeposited.toFixed(2)}, withdrawn $${vaultData.totalWithdrawn.toFixed(2)})`);
  console.log('='.repeat(60));

  // 8. Calculate unreported yield (minus entry/exit costs)
  const grossYield = totalNav - vaultData.totalAssets;
  const unreportedYield = grossYield - entryExitCosts;
  const reportableYield = unreportedYield;

  // Forward "all-OTM" upper bound: assume every open Derive short expires worthless
  // (we keep full subaccount cash) and every Rysk long expires worthless (mark → 0).
  // Delta vs the honest-MTM NAV is the unrealized buffer sitting in the option book.
  const deriveOpenShortMarkCost = (deriveData.usdcBalance || 0) - (deriveData.portfolioValue || 0);
  const otmExpiryBuffer = deriveOpenShortMarkCost - ryskLongMarkValue;
  const otmExpiryNav = totalNav + otmExpiryBuffer;
  const otmExpiryGap = otmExpiryNav - vaultData.totalAssets - entryExitCosts;
  const deriveExpiryValueAtSpot = (deriveData.usdcBalance || 0) + deriveIntrinsicAtSpot.netValue;
  const currentSpotExpiryNav = totalNav
    + (deriveExpiryValueAtSpot - deriveUsdcBalance)
    + (ryskLongIntrinsicAtSpot - ryskLongMarkValue);
  const currentSpotExpiryGap = currentSpotExpiryNav - vaultData.totalAssets - entryExitCosts;
  const optionExtrinsicNet = unreportedYield - currentSpotExpiryGap;

  console.log('');
  console.log('='.repeat(60));
  console.log('YIELD CALCULATION:');
  console.log(`  True NAV:             $${totalNav.toFixed(2)}`);
  console.log(`  Vault thinks NAV is:  $${vaultData.totalAssets.toFixed(2)}`);
  console.log(`  Gross yield:          $${grossYield.toFixed(2)}`);
  console.log(`  Entry/exit costs:     -$${entryExitCosts.toFixed(2)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  NET UNREPORTED YIELD: $${unreportedYield.toFixed(2)}  (honest MTM, conservative)`);
  console.log(`  INTRINSIC-ONLY GAP:   $${currentSpotExpiryGap.toFixed(2)}  (spot unchanged, options at intrinsic)`);
  console.log(`  Net option extrinsic: $${optionExtrinsicNet.toFixed(2)}  (MTM gap minus intrinsic gap)`);
  console.log(`  SAFE TO REPORT:       $${reportableYield.toFixed(2)}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('FORWARD RANGE (option book held to expiry):');
  console.log(`  Derive short MTM cost:    -$${deriveOpenShortMarkCost.toFixed(2)}  (paid if shorts settle at current mark)`);
  console.log(`  Derive intrinsic @ spot:  -$${deriveIntrinsicAtSpot.shortLiability.toFixed(2)}  (settlement if spot is unchanged)`);
  if (deriveIntrinsicAtSpot.longValue > 0) {
    console.log(`  Derive long intrinsic:    +$${deriveIntrinsicAtSpot.longValue.toFixed(2)}`);
  }
  console.log(`  Rysk long mark (offset):  +$${ryskLongMarkValue.toFixed(2)}  (current mark)`);
  console.log(`  Rysk intrinsic @ spot:    +$${ryskLongIntrinsicAtSpot.toFixed(2)}  (settlement if spot is unchanged)`);
  console.log(`  ─────────────────────────`);
  console.log(`  Current gap (now):        $${unreportedYield.toFixed(2)}`);
  console.log(`  Expiry @ current spot:    $${currentSpotExpiryGap.toFixed(2)}  (intrinsic settlement, no spot move)`);
  console.log(`  All-OTM scenario:         $${otmExpiryGap.toFixed(2)}  (only if Derive shorts expire worthless)`);
  if (deriveIntrinsicAtSpot.unknown > 0) {
    console.log(`  WARN: ${deriveIntrinsicAtSpot.unknown} Derive legs had no spot for intrinsic scenario`);
  }
  console.log('='.repeat(60));

  if (Math.abs(netExposure) * hypeCurrentPrice > 10000 || Math.abs(netLitExposure) * litCurrentPrice > 10000) {
    console.log('');
    console.log('EXPOSURE WARNINGS:');
    if (Math.abs(netExposure) * hypeCurrentPrice > 10000) {
      console.log(`  HYPE net exposure: ${netExposure.toFixed(2)} HYPE (~$${(netExposure * hypeCurrentPrice).toFixed(2)})`);
    }
    if (Math.abs(netLitExposure) * litCurrentPrice > 10000) {
      console.log(`  LIT net exposure:  ${netLitExposure.toFixed(2)} LIT (~$${(netLitExposure * litCurrentPrice).toFixed(2)})`);
    }
    console.log('='.repeat(60));
  }

  const currentHistoryEntry = {
    timestamp: new Date().toISOString(),
    nav: totalNav,
    vaultTotalAssets: vaultData.totalAssets,
    grossYield,
    unreportedYield,
    reportableYield,
    intrinsicOnlyGap: currentSpotExpiryGap,
    optionExtrinsicNet,
    sharePrice: vaultData.sharePrice,
    totalSupply: vaultData.totalSupply,
    hypeValue: totalHypeValue,
    ethValue,
    btcValue,
    usdcBalance,
    totalUsdcBalance,
    lighterCollateral: lighterData.collateral,
    lighterOperatorEquity: lighterOperatorData.equity,
    hyperliquidEquity: hyperliquidData.equity,
    hyperliquidCollateral,
    hyperliquidUnifiedCash,
    hyperliquidSpotUsdcTotal,
    hyperliquidSpotUsdcHeld: hyperliquidSpotData.usdcHeld || 0,
    hyperliquidSpotUsdcFree,
    hyperliquidSpotUsdcAvailableAfterMaintenance: hyperliquidSpotData.usdcAvailableAfterMaintenance || 0,
    hyperliquidPerpUnrealizedPnl: hyperliquidTotalUnrealizedPnl,
    hyperliquidCashNeutralPerpPnl,
    hyperliquidNonCashNeutralPerpPnl,
    kinetiqQueueHype,
    kinetiqQueueKhype: kinetiqQueueData.totalKhype || 0,
    kinetiqQueueClaims: kinetiqQueueData.claims.length,
    manualHypeAdjustment: MANUAL_HYPE_ADJUSTMENT,
    manualUsdcAdjustment: MANUAL_USDC_ADJUSTMENT,
    manualAdjustmentLabel: MANUAL_ADJUSTMENT_LABEL,
    litValue,
    ryskStableCollateral,
    hyperLendNonHypeValue,
    deriveUsdcBalance,
    ryskLongMarkValue,
    deriveOpenShortMarkCost,
    netHypeExposure: netExposure,
    netLitExposure: netLitExposure,
    // Cumulative flow tracking for cost socialization
    cumulativeDeposited: vaultData.totalDeposited,
    cumulativeWithdrawn: vaultData.totalWithdrawn,
    newDeposits,
    newWithdrawals,
    entryExitCosts,
  };

  printNavMovement(lastEntry, currentHistoryEntry);

  // 9. Calculate PPS-based yield (using history loaded earlier)
  const yesterday = lastEntry;

  if (yesterday) {
    const ppsDelta = vaultData.sharePrice - yesterday.sharePrice;
    const yieldFromPps = ppsDelta * vaultData.totalSupply;

    console.log('');
    console.log('PPS-BASED YIELD (vs last recorded):');
    console.log(`  Yesterday PPS:  $${yesterday.sharePrice.toFixed(6)}`);
    console.log(`  Today PPS:      $${vaultData.sharePrice.toFixed(6)}`);
    console.log(`  PPS Delta:      $${ppsDelta.toFixed(6)}`);
    console.log(`  Total Shares:   ${vaultData.totalSupply.toFixed(2)}`);
    console.log(`  Yield (PPS × Shares): $${yieldFromPps.toFixed(2)}`);
  }

  // 10. Save today's data
  history.entries.push(currentHistoryEntry);

  // Keep last 90 days
  if (history.entries.length > 90) {
    history.entries = history.entries.slice(-90);
  }

  saveNavHistory(history);

  // 11. Output for reporting
  console.log('');
  console.log('='.repeat(60));
  console.log('REPORTING READINGS:');
  console.log(`  MTM unreported yield:       $${unreportedYield.toFixed(2)}  (close-now / conservative)`);
  console.log(`  Intrinsic-only yield:       $${currentSpotExpiryGap.toFixed(2)}  (spot unchanged, expiry settlement)`);
  console.log(`  Net option extrinsic drag:  $${optionExtrinsicNet.toFixed(2)}`);
  console.log(`  Current SAFE TO REPORT:     $${reportableYield.toFixed(2)}  (current policy: MTM)`);
  console.log('');
  console.log('TO REPORT CURRENT POLICY YIELD:');
  console.log(`  cast send ${VAULT_ADDRESS} "reportYieldAndCollectFees(int256)" ${Math.round(reportableYield * 1e6)} --rpc-url ${ETH_RPC} --private-key <KEY>`);
  console.log('='.repeat(60));

  return {
    nav: totalNav,
    vaultTotalAssets: vaultData.totalAssets,
    grossYield,
    entryExitCosts,
    unreportedYield,
    reportableYield,
    sharePrice: vaultData.sharePrice,
    totalSupply: vaultData.totalSupply,
    accumulatedYield: vaultData.accumulatedYield,
    optionBook: {
      currentMtm: unreportedYield,
      intrinsicOnlyGap: currentSpotExpiryGap,
      optionExtrinsicNet,
      deriveShortMtmCost: -deriveOpenShortMarkCost,
      deriveShortIntrinsicCost: -deriveIntrinsicAtSpot.shortLiability,
      ryskLongMark: ryskLongMarkValue,
      ryskLongIntrinsic: ryskLongIntrinsicAtSpot,
      upperBoundIfAllOtm: otmExpiryGap,
      ryskUnmatchedLegs: ryskLongMarkData?.noDeriveMark || 0,
      ryskLegsAtIntrinsic: ryskLongMarkData?.valuedAtIntrinsic || 0,
      ryskLegsZeroValued: ryskLongMarkData?.unknown || 0,
    },
    flows: {
      newDeposits,
      newWithdrawals,
      totalVolume: totalFlowVolume,
      cumulativeDeposited: vaultData.totalDeposited,
      cumulativeWithdrawn: vaultData.totalWithdrawn,
    },
    breakdown: {
      hype: totalHypeValue,
      eth: ethValue,
      btc: btcValue,
      usdc: totalUsdcBalance,
      lighterCollateral: lighterData.collateral,
      lighterOperator: lighterOperatorData.equity,
      hyperliquidEquity: hyperliquidData.equity,
      hyperliquidUnifiedCash,
      lit: litValue,
      ryskStables: ryskStableCollateral,
      hyperLend: hyperLendNonHypeValue,
      hyperLendStableSupply: hyperLendStableValue,
      hyperLendStableDebt: hyperLendDebtValue,
      hyperLendHypeCollateralValue: hyperLendHypeCurrentValue,
      hyperLendRawNet: hyperLendHypeCurrentValue + hyperLendNonHypeValue,
      derive: deriveUsdcBalance,
    },
    // Detailed holdings for snapshot
    holdings: {
      ethereum: {
        eth: { amount: ethSpot, entryPrice: ethEntryPrice, value: ethValue },
        usdc: usdcBalance,
      },
      ryskMm: {
        address: RYSK_MM_ADDRESS,
        balances: ryskMmHyperBalances,
        stableValue: ryskMmStableBalance,
        hypeBalance: ryskMmHypeBalance,
        otherTrackedValue: ryskMmOtherTrackedValue,
      },
      lighterSpot: {
        usdc: lighterUsdcBalance,
        lit: litSpot,
      },
      hype: {
        manualAdjustment: MANUAL_HYPE_ADJUSTMENT,
        spotHypeEvm,
        spotHypeL1,
        ptHypeEquivalent: ptHypeEquiv,
        kinetiqQueue: {
          totalHypeEquivalent: kinetiqQueueHype,
          totalKhype: kinetiqQueueData.totalKhype || 0,
          totalFee: kinetiqQueueData.totalFee || 0,
          claims: kinetiqQueueData.claims,
          truncated: kinetiqQueueData.truncated,
        },
        totalHoldings: totalHypeHoldings,
        lighterShort: { size: lighterHypeShort.size, entryPrice: lighterHypeShort.entryPrice },
        hyperliquidShort: { size: hlHypeShort.size, entryPrice: hlHypeShort.entryPrice },
        totalShort: hypeExposure.totalShort,
        netExposure,
        currentPrice: hypeCurrentPrice,
        totalValue: totalHypeValue,
      },
      eth: {
        spotEth: ethSpot,
        lighterShort: { size: lighterEthShort.size, entryPrice: lighterEthShort.entryPrice },
        hyperliquidShort: { size: hlEthShort.size, entryPrice: hlEthShort.entryPrice },
        lighterLong: { size: lighterEthLong.size, entryPrice: lighterEthLong.entryPrice },
        hyperliquidLong: { size: hlEthLong.size, entryPrice: hlEthLong.entryPrice },
        netExposure: ethExposure.netExposure,
        currentPrice: currentEthPrice,
        totalValue: ethValue,
      },
      btc: {
        lighterShort: { size: lighterBtcShort.size, entryPrice: lighterBtcShort.entryPrice },
        hyperliquidShort: { size: hlBtcShort.size, entryPrice: hlBtcShort.entryPrice },
        lighterLong: { size: lighterBtcLong.size, entryPrice: lighterBtcLong.entryPrice },
        hyperliquidLong: { size: hlBtcLong.size, entryPrice: hlBtcLong.entryPrice },
        netExposure: btcExposure.netExposure,
        currentPrice: currentBtcPrice,
        totalValue: btcValue,
      },
      lighter: {
        collateral: lighterData.collateral,
        unrealizedPnl: lighterData.unrealizedPnl,
        equity: lighterData.equity,
        positions: lighterData.positions,
        operatorTrading: {
          collateral: lighterOperatorData.collateral,
          unrealizedPnl: lighterOperatorData.unrealizedPnl,
          equity: lighterOperatorData.equity,
          positions: lighterOperatorData.positions,
        },
        spotAssets: lighterSpotData.assets,
      },
      lit: {
        spotBalance: litSpotLighter,
        stakedBalance: stakedLit,
        stakedPrincipal: lighterStakedData.principalLIT || 0,
        pendingUnlockBalance: pendingUnlockLit,
        pendingUnlocks: lighterStakedData.pendingUnlocks || [],
        totalBalance: litSpot,
        lighterShort: { size: lighterLitShort.size, entryPrice: lighterLitShort.entryPrice },
        hyperliquidShort: { size: hlLitShort.size, entryPrice: hlLitShort.entryPrice },
        totalShort: litExposure.totalShort,
        netExposure: netLitExposure,
        currentPrice: litCurrentPrice,
        totalValue: litValue,
      },
      hyperliquid: {
        equity: hyperliquidData.equity,
        collateral: hyperliquidCollateral,
        unrealizedPnl: hyperliquidTotalUnrealizedPnl,
        unifiedCash: hyperliquidUnifiedCash,
        cashNeutralPerpPnl: hyperliquidCashNeutralPerpPnl,
        nonCashNeutralPerpPnl: hyperliquidNonCashNeutralPerpPnl,
        spotUsdc: {
          counted: hyperliquidUsdcBalance,
          total: hyperliquidSpotUsdcTotal,
          free: hyperliquidSpotUsdcFree,
          heldMargin: hyperliquidSpotData.usdcHeld || 0,
          availableAfterMaintenance: hyperliquidSpotData.usdcAvailableAfterMaintenance || 0,
        },
        positions: hyperliquidData.positions.map(pos => {
          const position = pos.position || pos;
          return {
            coin: position.coin || pos.coin,
            size: parseFloat(position.szi || pos.szi || 0),
            entryPrice: parseFloat(position.entryPx || pos.entryPx || 0),
            unrealizedPnl: parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0),
          };
        }),
      },
      manualAdjustments: {
        label: MANUAL_ADJUSTMENT_LABEL,
        hype: MANUAL_HYPE_ADJUSTMENT,
        usdc: MANUAL_USDC_ADJUSTMENT,
      },
      pendle: {
        positions: pendleData.positions,
        totalUsd: pendleData.totalUsd,
        totalHypeEquivalent: pendleData.totalHypeEquivalent,
      },
      rysk: {
        totalCollateralUsdt0: ryskData.totalCollateralUsdt0,
        totalCollateralUsdc: ryskData.totalCollateralUsdc,
        totalCollateralUsdh: ryskData.totalCollateralUsdh,
        totalCollateralWhype: ryskData.totalCollateralWhype,
        operatorMarginPool: ryskOperatorMarginPool,
        positions: ryskData.positions,
        vaultCount: ryskData.vaultCount,
        mmTotalCollateralUsdt0: ryskMmVaultData.totalCollateralUsdt0,
        mmTotalCollateralUsdc: ryskMmVaultData.totalCollateralUsdc,
        mmTotalCollateralUsdh: ryskMmVaultData.totalCollateralUsdh,
        mmTotalCollateralWhype: ryskMmVaultData.totalCollateralWhype,
        mmMarginPool: ryskMmMarginPool,
        mmPositions: ryskMmVaultData.positions,
        mmVaultCount: ryskMmVaultData.vaultCount,
        combinedStableCollateral: ryskStableCollateral,
        shortIntrinsicLiability: ryskOptionIntrinsicLiability,
      },
      hyperLend: {
        supplies: hyperLendData.supplies,
        debts: hyperLendData.debts,
        totalCollateralUsd: hyperLendData.totalCollateralUsd,
        totalDebtUsd: hyperLendData.totalDebtUsd,
        netValueUsd: hyperLendData.netValueUsd,
      },
      derive: {
        usdcBalance: deriveData.usdcBalance,
        portfolioValue: deriveData.portfolioValue,
        accountValue: deriveData.accountValue,
        manualPortfolioValue: deriveData.manualPortfolioValue,
        openShortMarkCost: deriveData.openShortMarkCost,
        openLongMarkValue: deriveData.openLongMarkValue,
        positionsValue: deriveData.positionsValue,
        collateralValue: deriveData.collateralValue,
        initialMargin: deriveData.initialMargin,
        maintenanceMargin: deriveData.maintenanceMargin,
        openOrdersMargin: deriveData.openOrdersMargin,
        positions: deriveData.positions,
        openOrders: deriveData.openOrders,
      },
    },
  };
}

// Run with snapshot prompt
async function main() {
  const publishOnly = process.argv.includes('--publish-only');
  const result = await calculateYield();

  if (publishOnly) {
    publishBackingSnapshot(buildBackingSnapshot(result));
    return;
  }

  console.log('');
  const answer = await promptUser('Save snapshot after yield report? (y/n): ');

  if (answer === 'y' || answer === 'yes') {
    const snapshot = {
      timestamp: new Date().toISOString(),
      yieldReported: result.reportableYield,
      nav: result.nav,
      sharePrice: result.sharePrice,
      totalSupply: result.totalSupply,
      accumulatedYield: result.accumulatedYield,
      holdings: result.holdings,
      breakdown: result.breakdown,
    };
    saveYieldSnapshot(snapshot);
    publishBackingSnapshot(buildBackingSnapshot(result));
  } else {
    console.log('Snapshot not saved.');
  }
}

main().catch(console.error);
