import { createPublicClient, http, formatUnits, createWalletClient } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync, createReadStream } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFileSync } from 'child_process';

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

// Token addresses
const TOKENS = {
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  },
  hyperevm: {
    USDC: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 },
    WHYPE: { address: '0x5555555555555555555555555555555555555555', decimals: 18 },
    USDT0: { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },
    USDH: { address: '0x111111a1a0667d36bd57c0a9f569b98057111111', decimals: 6 },
  },
};

// Stablecoin symbols (always valued at $1)
const STABLECOINS = ['USDC', 'USDT', 'USDT0', 'USDH', 'DAI'];


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

  return { totalHoldings, totalShort: netShort, netExposure, totalValue, currentPrice };
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

// Market index to symbol mapping
const LIGHTER_MARKETS = {
  0: 'ETH',
  1: 'BTC',
  24: 'HYPE',
  120: 'LIT',
};

async function fetchLighterEquity(addresses, options = {}) {
  try {
    const includeDefaultAccount = options.includeDefaultAccount !== false;
    const addressList = Array.isArray(addresses) ? addresses : [addresses];
    let totalCollateral = 0;
    const accountIndexes = new Set(includeDefaultAccount ? [String(LIGHTER_ACCOUNT_INDEX)] : []);

    for (const address of addressList) {
      const accountResponse = await fetch(
        `https://mainnet.zklighter.elliot.ai/api/v1/accountsByL1Address?l1_address=${address}`
      );
      if (!accountResponse.ok) continue;

      const accountData = await accountResponse.json();
      const subAccounts = accountData.sub_accounts || [];

      for (const account of subAccounts) {
        totalCollateral += parseFloat(account.collateral || 0);
        if (account.index) {
          accountIndexes.add(String(account.index));
        }
      }
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
    };
  } catch (e) {
    console.warn('Failed to fetch Lighter equity:', e.message);
    return { collateral: 0, unrealizedPnl: 0, equity: 0, positions: [] };
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

    const collateralDecimals = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 6;
      if (lower === HYPEREVM_USDC.toLowerCase()) return 6;
      if (lower === USDH_ADDRESS.toLowerCase()) return 6;
      if (lower === WHYPE_ADDRESS.toLowerCase()) return 18;
      return 18; // default
    };

    const collateralSymbol = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 'USDT0';
      if (lower === HYPEREVM_USDC.toLowerCase()) return 'USDC';
      if (lower === USDH_ADDRESS.toLowerCase()) return 'USDH';
      if (lower === WHYPE_ADDRESS.toLowerCase()) return 'WHYPE';
      return 'UNKNOWN';
    };

    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i];
      if (!vault) continue;

      const shortAddr = vault.shortOtokens?.[0];
      const collateralAddr = vault.collateralAssets?.[0];
      const collateralRaw = vault.collateralAmounts?.[0] || 0n;
      const shortAmount = vault.shortAmounts?.[0] || 0n;

      if (!shortAddr || shortAddr === '0x0000000000000000000000000000000000000000') continue;
      if (collateralRaw === 0n && shortAmount === 0n) continue;

      const decimals = collateralAddr ? collateralDecimals(collateralAddr) : 6;
      const symbol = collateralAddr ? collateralSymbol(collateralAddr) : 'UNKNOWN';
      const collateralAmount = parseFloat(formatUnits(collateralRaw, decimals));
      const contracts = Number(shortAmount) / 1e8;

      const details = otokenDetails[shortAddr];
      const expiry = details ? new Date(details.expiryTimestamp * 1000) : null;

      if (symbol === 'USDT0') totalCollateralUsdt0 += collateralAmount;
      else if (symbol === 'USDC') totalCollateralUsdc += collateralAmount;
      else if (symbol === 'USDH') totalCollateralUsdh += collateralAmount;
      else if (symbol === 'WHYPE') totalCollateralWhype += collateralAmount;

      positions.push({
        vaultId: i + 1,
        type: details?.isPut ? 'PUT' : 'CALL',
        strike: details?.strikePrice || 0,
        expiry: expiry ? expiry.toISOString().split('T')[0] : 'unknown',
        contracts,
        collateral: collateralAmount,
        collateralSymbol: symbol,
      });
    }

    return {
      totalCollateralUsdt0,
      totalCollateralUsdc,
      totalCollateralUsdh,
      totalCollateralWhype,
      totalCollateral: totalCollateralUsdt0 + totalCollateralUsdc + totalCollateralUsdh, // USD-denominated portion
      positions,
      vaultCount: count,
    };
  } catch (e) {
    console.warn('Failed to fetch Rysk positions:', e.message);
    return { totalCollateralUsdt0: 0, totalCollateralUsdc: 0, totalCollateralUsdh: 0, totalCollateralWhype: 0, totalCollateral: 0, positions: [], vaultCount: 0 };
  }
}

function fetchRyskMarginPoolBalances(address) {
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
    return 18

try:
    client.on_response(_on_response)
    with contextlib.redirect_stdout(io.StringIO()):
        client.start(subscribe_assets=[])
    client.get_balances(account)
    time.sleep(2.5)
    entries = []
    for resp in responses:
        if isinstance(resp, dict) and resp.get("id") == "balances":
            entries = resp.get("result", []) or []
            break
    out = {}
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
    print(json.dumps(out))
finally:
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            client.stop()
    except Exception:
        pass
`;
    const stdout = execFileSync('/Users/onomeokajevo/AYP/.venv/bin/python3', ['-c', py], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const jsonText = extractJsonObject(stdout);
    const parsed = jsonText ? JSON.parse(jsonText) : {};
    return {
      usdt0: num(parsed.USDT0),
      usdc: num(parsed.USDC),
      usdh: num(parsed.USDH),
      whype: num(parsed.WHYPE),
    };
  } catch (e) {
    console.warn(`Failed to fetch Rysk MarginPool balances for ${address}:`, e.message);
    return { usdt0: 0, usdc: 0, usdh: 0, whype: 0 };
  }
}

// ============================================
// Rysk LONG valuation (mark-based, via Derive)
// ============================================
// Symmetric counterpart to the existing short-side intrinsic-liability deduction.
// Active Rysk longs (oTokens we hold) are not visible on-chain from `fetchRyskPositions`
// because that reads vault shorts. We use the v3 trade ledger as source of truth and
// value each leg at the matching Derive instrument's mark price (fair-value reference).
const RYSK_LONG_ACTIVE_PHASES = new Set(['spread_active', 'gap', 'hedging', 'gamma_active']);
const DERIVE_TICKER_URL = 'https://api.lyra.finance/public/get_ticker';

async function loadActiveRyskLongs() {
  const ledgerPath = join(__dirname, '..', 'data', 'v3', 'trades.jsonl');
  if (!existsSync(ledgerPath)) return [];
  const latest = new Map();
  const rl = createInterface({ input: createReadStream(ledgerPath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const tid = r.trade_id;
    if (!tid) continue;
    const prev = latest.get(tid);
    if (!prev || (r.updated_at || '') >= (prev.updated_at || '')) latest.set(tid, r);
  }
  const groups = new Map();
  const nowMs = Date.now();
  for (const r of latest.values()) {
    if (!RYSK_LONG_ACTIVE_PHASES.has(r.phase)) continue;
    if (r.rysk_direction !== 'we_bought') continue;
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

function deriveInstrumentName(underlying, expiryMs, strike, isPut) {
  const yyyymmdd = new Date(expiryMs).toISOString().slice(0, 10).replace(/-/g, '');
  let s = strike.toString();
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return `${underlying}-${yyyymmdd}-${s}-${isPut ? 'P' : 'C'}`;
}

async function fetchDeriveMark(instrument) {
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
    for (const k of ['mark_price', 'best_ask_price', 'best_bid_price']) {
      const v = parseFloat(t[k] || '0');
      if (v > 0) return v;
    }
  } catch {}
  return null;
}

function computeOptionIntrinsic(underlying, strike, isPut, size, spot) {
  if (!spot || spot <= 0) return 0;
  const per = isPut ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  return per * size;
}

// Value live Rysk longs leg by leg.
// Priority per leg: Derive mark when listed -> intrinsic value at spot.
// This mirrors paired_gamma_pnl.py: a leg without a Derive twin still has
// real economic value (intrinsic), so we never silently zero gamma legs.
async function valueRyskLongs(groups, spotPrices) {
  if (!groups || groups.length === 0) {
    return { totalValue: 0, positions: [], noDeriveMark: 0, valuedAtIntrinsic: 0, unknown: 0 };
  }
  for (const g of groups) {
    const isPut = g.optionType === 'PUT';
    const inst = deriveInstrumentName(g.underlying, g.expiryMs, g.strike, isPut);
    g.instrument = inst;
    g.mark = await fetchDeriveMark(inst);
    const spot = spotPrices?.[g.underlying];
    g.intrinsic = computeOptionIntrinsic(g.underlying, g.strike, isPut, g.size, spot);
    if (g.mark != null) {
      g.value = g.mark * g.size;
      g.markSource = 'derive';
    } else if (spot && spot > 0) {
      g.value = g.intrinsic;
      g.markSource = 'intrinsic';
    } else {
      g.value = 0;
      g.markSource = 'unknown';
    }
  }
  const totalValue = groups.reduce((s, g) => s + g.value, 0);
  const noDeriveMark = groups.filter((g) => g.mark == null).length;
  const valuedAtIntrinsic = groups.filter((g) => g.markSource === 'intrinsic').length;
  const unknown = groups.filter((g) => g.markSource === 'unknown').length;
  return { totalValue, positions: groups, noDeriveMark, valuedAtIntrinsic, unknown };
}

function calculateRyskIntrinsicLiability(positions, currentHypePrice) {
  if (!currentHypePrice || currentHypePrice <= 0) return 0;
  return positions.reduce((sum, pos) => {
    if (pos.type === 'PUT') {
      return sum + Math.max(pos.strike - currentHypePrice, 0) * pos.contracts;
    }
    if (pos.type === 'CALL') {
      return sum + Math.max(currentHypePrice - pos.strike, 0) * pos.contracts;
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
  USDT0: { address: '0x10982ad645D5A112606534d8567418Cf64c14cB5', decimals: 6, underlying: USDT0_ADDRESS },
  USDC: { address: '0x744E4f26ee30213989216E1632D9BE3547C4885b', decimals: 6, underlying: HYPEREVM_USDC },
};

const HYPERLEND_DEBT_TOKENS = {
  WHYPE: { address: '0x747d0d4Ba0a2083651513cd008deb95075683e82', decimals: 18 },
  USDT0: { address: '0x1EF897622D62335e7FC88Fb0605FbBa28eC0b01d', decimals: 6 },
  USDC: { address: '0xD612513cB3b2C52abCD6d4b338374C09AdA4657d', decimals: 6 },
};

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
  const subaccount = await fetchDerivePrivate('get_subaccount', params);
  const collaterals = await fetchDerivePrivate('get_collaterals', params);
  const positionsData = await fetchDerivePrivate('get_positions', params);
  const ordersData = await fetchDerivePrivate('get_open_orders', params);
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
    const fetched = await Promise.all(subaccountIds.map(fetchDeriveSubaccount));
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
      return { balances: [], hypeBalance: 0 };
    }

    const data = await response.json();
    const balances = data.balances || [];

    // Find HYPE balance (token index for HYPE on Hyperliquid spot)
    let hypeBalance = 0;
    let usdcBalance = 0;
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
        const amount = parseFloat(bal.hold || bal.total || 0) + parseFloat(bal.available || 0);
        usdcBalance = parseFloat(bal.total) || amount;
      }
    }

    return {
      balances,
      hypeBalance,
      usdcBalance,
    };
  } catch (e) {
    console.warn('Failed to fetch Hyperliquid spot:', e.message);
    return { balances: [], hypeBalance: 0, usdcBalance: 0 };
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
      solValue,
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
        { label: 'HYPE (hedged)',         value: result.breakdown.hype },
        { label: 'Hyperliquid (equity)',  value: result.breakdown.hyperliquidEquity },
        { label: 'Lighter (collateral)',  value: result.breakdown.lighterCollateral },
        { label: 'Lighter operator',      value: result.breakdown.lighterOperator },
        { label: 'Rysk longs (mark)',     value: result.optionBook.ryskLongMark },
        { label: 'Rysk (stables)',        value: result.breakdown.ryskStables },
        { label: 'USDC (idle)',           value: result.breakdown.usdc },
        { label: 'HyperLend (net)',       value: result.breakdown.hyperLend },
        { label: 'ETH exposure',          value: result.breakdown.eth },
        { label: 'SOL (hedged)',          value: result.breakdown.sol },
        { label: 'BTC perp PnL',          value: result.breakdown.btc },
      ].filter((b) => Number.isFinite(b.value) && Math.abs(b.value) > 0.005),
    },
    exposures: {
      hype: h.hype && {
        totalHoldings: h.hype.totalHoldings,
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
      sol: h.solana && {
        totalSol: h.solana.totalSol,
        currentPrice: h.solana.solPrice,
        totalValue: h.solana.solValue,
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
      },
      pendle: h.pendle && {
        totalUsd: h.pendle.totalUsd,
        positionCount: (h.pendle.positions || []).length,
      },
    },
    optionBook: {
      currentMtm: result.optionBook.currentMtm,
      deriveShortMtmCost: result.optionBook.deriveShortMtmCost,
      ryskLongMark: result.optionBook.ryskLongMark,
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

function pushBackingSnapshot() {
  const repoRoot = join(__dirname, '..');
  const rel = 'frontend/public/backing.json';
  try {
    const diff = execFileSync('git', ['diff', '--quiet', '--', rel], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
    // exit 0 = no change; we only reach here if --quiet exited 0
    console.log('Backing snapshot unchanged, skipping push.');
    return;
  } catch (e) {
    // exit 1 = file has changes, fall through to commit
    if (e.status !== 1) {
      console.warn('git diff failed, skipping auto-push:', e.message);
      return;
    }
  }
  try {
    execFileSync('git', ['add', rel], { cwd: repoRoot, stdio: 'inherit' });
    execFileSync('git', ['commit', '--only', rel, '-m', 'Update backing.json snapshot'], {
      cwd: repoRoot, stdio: 'inherit',
    });
    execFileSync('git', ['push'], { cwd: repoRoot, stdio: 'inherit' });
    console.log('Backing snapshot committed and pushed.');
  } catch (e) {
    console.warn('Auto-push failed, commit/push manually:', e.message);
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

  // 2. Fetch all position data in parallel
  const [
    multisigEthBalances,
    multisigHyperBalances,
    operatorHyperBalances,
    ryskMmHyperBalances,
    pendleData,
    lighterData,
    lighterOperatorData,
    lighterSpotData,
    lighterStakedData,
    hyperliquidData,
    solanaData,
    vaultData,
    hyperliquidSpotData,
    ryskData,
    ryskMmVaultData,
    ryskOperatorMarginPool,
    ryskMmMarginPool,
    hyperLendData,
    deriveData,
    ryskLongLegs,
  ] = await Promise.all([
    fetchEthereumBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(OPERATOR_ADDRESS),
    fetchHyperEvmBalances(RYSK_MM_ADDRESS),
    fetchPendlePositions(MULTISIG_ADDRESS, usdcPrice),
    fetchLighterEquity(MULTISIG_ADDRESS, { includeDefaultAccount: true }),
    fetchLighterEquity(OPERATOR_ADDRESS, { includeDefaultAccount: false }),
    fetchLighterSpotAssets(),
    fetchLighterStakedLIT(),
    fetchHyperliquidEquity(OPERATOR_ADDRESS),
    fetchSolanaData(OPERATOR_SOLANA_ADDRESS, usdcPrice),
    fetchVaultData(),
    fetchHyperliquidSpot(OPERATOR_ADDRESS),
    fetchRyskPositions(OPERATOR_ADDRESS),
    fetchRyskPositions(RYSK_MM_ADDRESS),
    fetchRyskMarginPoolBalances(OPERATOR_ADDRESS),
    fetchRyskMarginPoolBalances(RYSK_MM_ADDRESS),
    fetchHyperLendPositions(OPERATOR_ADDRESS),
    fetchDerivePositions(),
    loadActiveRyskLongs(),
  ]);

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
    ...multisigHyperBalances,
    ...operatorHyperBalances,
    ...ryskMmHyperBalances,
  ];

  for (const bal of allSpotBalances) {
    let price;
    let priceSource;

    if (STABLECOINS.includes(bal.symbol)) {
      // Stablecoins always $1
      price = 1;
      priceSource = 'stable';
    } else if (entryPrices[bal.symbol]) {
      // Hedged asset - use entry price
      price = entryPrices[bal.symbol];
      priceSource = 'entry';
    } else if (bal.symbol === 'HYPE' || bal.symbol === 'WHYPE') {
      // Handled in HYPE exposure analysis
      continue;
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
    .filter(b => b.symbol === 'HYPE' || b.symbol === 'WHYPE')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  const ryskMmOtherTrackedValue = ryskMmHyperBalances
    .filter(b => !STABLECOINS.includes(b.symbol) && b.symbol !== 'HYPE' && b.symbol !== 'WHYPE')
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
      console.log(`  HYPE / WHYPE:      ${ryskMmHypeBalance.toFixed(4)} HYPE`);
    }
    if (ryskMmOtherTrackedValue > 0) {
      console.log(`  Other tracked val: $${ryskMmOtherTrackedValue.toFixed(2)}`);
    }
  }

  // 4. Calculate HYPE exposure and hedged/unhedged portions
  console.log('');
  console.log('HYPE EXPOSURE ANALYSIS:');

  const spotHypeEvm = allSpotBalances
    .filter(b => b.symbol === 'HYPE' || b.symbol === 'WHYPE')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  console.log(`  Spot HYPE (EVM):  ${spotHypeEvm.toFixed(2)} HYPE`);

  const spotHypeL1 = hyperliquidSpotData.hypeBalance || 0;
  if (spotHypeL1 > 0) {
    console.log(`  Spot HYPE (HL):   ${spotHypeL1.toFixed(2)} HYPE`);
  }

  const ptHypeEquiv = pendleData.totalHypeEquivalent || 0;
  console.log(`  PT HYPE equiv:    ${ptHypeEquiv.toFixed(2)} HYPE`);

  // WHYPE locked in Rysk covered calls (still our spot HYPE, hedged by perp short)
  const ryskOperatorWhype = (ryskData.totalCollateralWhype || 0) + (ryskOperatorMarginPool.whype || 0);
  const ryskMmWhype = (ryskMmVaultData.totalCollateralWhype || 0) + (ryskMmMarginPool.whype || 0);
  const ryskWhype = ryskOperatorWhype + ryskMmWhype;
  if (ryskWhype > 0) {
    console.log(`  Rysk (locked):    ${ryskWhype.toFixed(2)} HYPE`);
  }

  // WHYPE supplied on HyperLend (earning yield, hedged by perp short)
  const hyperLendWhypeHolding = hyperLendData.supplies['WHYPE'] || 0;
  if (hyperLendWhypeHolding > 0) {
    console.log(`  HyperLend:        ${hyperLendWhypeHolding.toFixed(2)} HYPE`);
  }

  const totalHypeHoldings = spotHypeEvm + spotHypeL1 + ptHypeEquiv + ryskWhype + hyperLendWhypeHolding;
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

  // 5. Perp positions (collateral only - unrealized PnL offsets spot price changes)
  console.log('');
  console.log('LIGHTER (collateral only - hedged positions):');
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

  // Calculate SOL exposure with Hyperliquid hedge
  console.log('');
  console.log('SOL EXPOSURE ANALYSIS:');
  console.log(`  Native SOL:          ${solanaData.solBalance.toFixed(4)} SOL`);
  console.log(`  Staked SOL:          ${solanaData.stakedSol.toFixed(4)} SOL`);
  console.log(`  ─────────────────────────`);
  console.log(`  Total holdings:      ${solanaData.totalSol.toFixed(4)} SOL`);

  const hlSolShort = findHyperliquidShort(hyperliquidData.positions, 'SOL');
  const currentSolPrice = solanaData.solPrice || derivePriceFromShort(hlSolShort);

  const solExposure = calculateHedgedExposure({
    symbol: 'SOL',
    totalHoldings: solanaData.totalSol,
    shorts: [{ venue: 'Hyperliquid', ...hlSolShort }],
    currentPrice: currentSolPrice,
  });
  let solValue = solExposure.totalValue;

  if (solanaData.stakeAccounts.length > 0) {
    console.log('  Stake Accounts:');
    for (const stake of solanaData.stakeAccounts) {
      console.log(`    ${stake.pubkey.slice(0, 8)}...: ${stake.amount.toFixed(4)} SOL`);
    }
  }

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

  const litSpot = litSpotLighter + stakedLit;
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

  // Rysk Finance (options)
  console.log('');
  console.log('RYSK (Options on HyperEVM):');
  console.log(`  MarginPool:        ${RYSK_MARGIN_POOL_ADDRESS}`);
  const totalRyskVaults = (ryskData.positions.length || 0) + (ryskMmVaultData.positions.length || 0);
  const operatorRyskUsdt0 = (ryskData.totalCollateralUsdt0 || 0) + (ryskOperatorMarginPool.usdt0 || 0);
  const operatorRyskUsdc = (ryskData.totalCollateralUsdc || 0) + (ryskOperatorMarginPool.usdc || 0);
  const operatorRyskUsdh = (ryskData.totalCollateralUsdh || 0) + (ryskOperatorMarginPool.usdh || 0);
  const operatorRyskWhype = (ryskData.totalCollateralWhype || 0) + (ryskOperatorMarginPool.whype || 0);
  const mmRyskUsdt0 = (ryskMmVaultData.totalCollateralUsdt0 || 0) + (ryskMmMarginPool.usdt0 || 0);
  const mmRyskUsdc = (ryskMmVaultData.totalCollateralUsdc || 0) + (ryskMmMarginPool.usdc || 0);
  const mmRyskUsdh = (ryskMmVaultData.totalCollateralUsdh || 0) + (ryskMmMarginPool.usdh || 0);
  const mmRyskWhype = (ryskMmVaultData.totalCollateralWhype || 0) + (ryskMmMarginPool.whype || 0);
  const totalRyskStableCollateral = operatorRyskUsdt0 + operatorRyskUsdc + operatorRyskUsdh + mmRyskUsdt0 + mmRyskUsdc + mmRyskUsdh;
  const totalRyskUsdt0 = operatorRyskUsdt0 + mmRyskUsdt0;
  const totalRyskUsdc = operatorRyskUsdc + mmRyskUsdc;
  const totalRyskUsdh = operatorRyskUsdh + mmRyskUsdh;
  const totalRyskWhype = operatorRyskWhype + mmRyskWhype;
  const allRyskOptionPositions = [
    ...ryskData.positions,
    ...ryskMmVaultData.positions,
  ];
  const ryskOptionIntrinsicLiability = calculateRyskIntrinsicLiability(allRyskOptionPositions, hypeCurrentPrice);

  if (totalRyskVaults > 0 || totalRyskStableCollateral > 0 || totalRyskWhype > 0) {
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
    console.log(`  Short intrinsic:   -$${ryskOptionIntrinsicLiability.toFixed(2)}`);
    console.log(`  Operator vaults:   ${ryskData.vaultCount}`);
    console.log(`  MM wallet vaults:  ${ryskMmVaultData.vaultCount}`);
    if (operatorRyskUsdt0 > 0 || operatorRyskUsdc > 0 || operatorRyskUsdh > 0 || ryskOperatorMarginPool.whype > 0) {
      console.log(`  Operator MarginPool: USDT0=$${ryskOperatorMarginPool.usdt0.toFixed(2)} USDC=$${ryskOperatorMarginPool.usdc.toFixed(2)} USDH=$${ryskOperatorMarginPool.usdh.toFixed(2)} WHYPE=${ryskOperatorMarginPool.whype.toFixed(4)}`);
    }
    if (mmRyskUsdt0 > 0 || mmRyskUsdc > 0 || mmRyskUsdh > 0 || ryskMmMarginPool.whype > 0) {
      console.log(`  MM MarginPool:      USDT0=$${ryskMmMarginPool.usdt0.toFixed(2)} USDC=$${ryskMmMarginPool.usdc.toFixed(2)} USDH=$${ryskMmMarginPool.usdh.toFixed(2)} WHYPE=${ryskMmMarginPool.whype.toFixed(4)}`);
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
  if (Object.keys(hyperLendData.supplies).length > 0) {
    for (const [symbol, amount] of Object.entries(hyperLendData.supplies)) {
      if (symbol === 'WHYPE') {
        console.log(`  Supplied WHYPE:    ${amount.toFixed(4)} (counted in HYPE exposure)`);
      } else {
        console.log(`  Supplied ${symbol}:    $${amount.toFixed(2)}`);
      }
    }
    for (const [symbol, amount] of Object.entries(hyperLendData.debts)) {
      console.log(`  Debt ${symbol}:       -$${amount.toFixed(2)}`);
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
        console.log(`    ${pos.instrument} ${side} ${Math.abs(pos.amount)} @ $${pos.averagePrice.toFixed(2)} (mark: $${pos.markPrice.toFixed(2)}, P&L: $${pos.unrealizedPnl.toFixed(2)})`);
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

  // Add Hyperliquid spot USDC
  const hyperliquidUsdcBalance = hyperliquidSpotData.usdcBalance || 0;

  const totalUsdcBalance = usdcBalance + lighterUsdcBalance + hyperliquidUsdcBalance;

  // Rysk stable collateral (USDT0 + USDC + USDH at $1). WHYPE is counted in HYPE exposure above.
  const ryskStableCollateral = totalRyskStableCollateral - ryskOptionIntrinsicLiability;

  // HyperLend: WHYPE is counted in HYPE exposure. Only add non-WHYPE supplies here.
  const hyperLendStableValue = (hyperLendData.supplies['USDT0'] || 0) + (hyperLendData.supplies['USDC'] || 0);
  // Subtract any debts
  const hyperLendDebtValue = Object.values(hyperLendData.debts).reduce((sum, v) => sum + v, 0);
  const hyperLendNonHypeValue = hyperLendStableValue - hyperLendDebtValue;

  // Derive.xyz: use portfolio value (USDC minus current mark cost of open shorts)
  const deriveUsdcBalance = deriveData.portfolioValue;

  // Rysk longs (live legs). Derive mark when the leg has a listed twin,
  // intrinsic at spot otherwise. Without intrinsic fallback, gamma legs
  // (no Derive counterpart by design) silently zero out and inflate drawdown.
  const ryskLongSpotPrices = {
    HYPE: hypeCurrentPrice,
    BTC: currentBtcPrice,
    ETH: currentEthPrice,
    SOL: currentSolPrice,
    LIT: litCurrentPrice,
  };
  const ryskLongMarkData = await valueRyskLongs(ryskLongLegs, ryskLongSpotPrices);
  const ryskLongMarkValue = ryskLongMarkData?.totalValue || 0;

  const totalNav = totalHypeValue + ethValue + btcValue + totalUsdcBalance + lighterData.collateral + lighterOperatorData.equity + hyperliquidCollateral + solValue + litValue + ryskStableCollateral + hyperLendNonHypeValue + deriveUsdcBalance + ryskLongMarkValue;

  console.log('');
  console.log('='.repeat(60));
  console.log('NAV SUMMARY (Delta-Neutral Valuation):');
  console.log(`  HYPE (hedged):    $${totalHypeValue.toFixed(2)}`);
  console.log(`  SOL (hedged):     $${solValue.toFixed(2)}`);
  console.log(`  LIT (hedged):     $${litValue.toFixed(2)}`);
  console.log(`  ETH exposure:     $${ethValue.toFixed(2)}`);
  if (Math.abs(btcValue) > 0.01) {
    console.log(`  BTC perp PnL:     $${btcValue.toFixed(2)}`);
  }
  console.log(`  USDC:             $${totalUsdcBalance.toFixed(2)}`);
  if (lighterUsdcBalance > 0) {
    console.log(`    (incl. Lighter spot: $${lighterUsdcBalance.toFixed(2)})`);
  }
  if (hyperliquidUsdcBalance > 0) {
    console.log(`    (incl. Hyperliquid spot: $${hyperliquidUsdcBalance.toFixed(2)})`);
  }
  console.log(`  Lighter collat:   $${lighterData.collateral.toFixed(2)}`);
  if (lighterOperatorData.equity !== 0) {
    console.log(`  Lighter operator: $${lighterOperatorData.equity.toFixed(2)}`);
  }
  if (hyperliquidCollateral > 0) {
    console.log(`  Hyperliquid col:  $${hyperliquidCollateral.toFixed(2)}`);
  }
  if (ryskStableCollateral > 0) {
    console.log(`  Rysk (stables):   $${ryskStableCollateral.toFixed(2)}`);
  }
  if (hyperLendNonHypeValue > 0) {
    console.log(`  HyperLend:        $${hyperLendNonHypeValue.toFixed(2)}`);
  }
  if (deriveUsdcBalance > 0) {
    console.log(`  Derive (USDC):    $${deriveUsdcBalance.toFixed(2)}`);
  }
  if (ryskLongMarkValue !== 0 || ryskLongMarkData?.positions?.length) {
    console.log(`  Rysk longs (mark):$${ryskLongMarkValue.toFixed(2)}`);
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

  // Forward "all-OTM" upper bound: assume every open Derive short expires worthless
  // (we keep full subaccount cash) and every Rysk long expires worthless (mark → 0).
  // Delta vs the honest-MTM NAV is the unrealized buffer sitting in the option book.
  const deriveOpenShortMarkCost = (deriveData.usdcBalance || 0) - (deriveData.portfolioValue || 0);
  const otmExpiryBuffer = deriveOpenShortMarkCost - ryskLongMarkValue;
  const otmExpiryNav = totalNav + otmExpiryBuffer;
  const otmExpiryGap = otmExpiryNav - vaultData.totalAssets - entryExitCosts;

  console.log('');
  console.log('='.repeat(60));
  console.log('YIELD CALCULATION:');
  console.log(`  True NAV:             $${totalNav.toFixed(2)}`);
  console.log(`  Vault thinks NAV is:  $${vaultData.totalAssets.toFixed(2)}`);
  console.log(`  Gross yield:          $${grossYield.toFixed(2)}`);
  console.log(`  Entry/exit costs:     -$${entryExitCosts.toFixed(2)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  NET UNREPORTED YIELD: $${unreportedYield.toFixed(2)}  (honest MTM, conservative)`);
  console.log(`  SAFE TO REPORT:       $${unreportedYield.toFixed(2)}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('FORWARD RANGE (option book held to expiry):');
  console.log(`  Derive short MTM cost:    -$${deriveOpenShortMarkCost.toFixed(2)}  (paid if shorts settle at current mark)`);
  console.log(`  Rysk long mark (offset):  +$${ryskLongMarkValue.toFixed(2)}  (recovered if longs settle at current mark)`);
  console.log(`  ─────────────────────────`);
  console.log(`  Current gap (now):        $${unreportedYield.toFixed(2)}`);
  console.log(`  Upper bound (all OTM):    $${otmExpiryGap.toFixed(2)}  (Derive shorts decay to 0, perp churn = 0)`);
  console.log('='.repeat(60));

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
  history.entries.push({
    timestamp: new Date().toISOString(),
    nav: totalNav,
    sharePrice: vaultData.sharePrice,
    totalSupply: vaultData.totalSupply,
    hypeValue: totalHypeValue,
    ethValue,
    btcValue,
    usdcBalance,
    lighterCollateral: lighterData.collateral,
    lighterOperatorEquity: lighterOperatorData.equity,
    hyperliquidEquity: hyperliquidData.equity,
    solValue,
    litValue,
    ryskStableCollateral,
    hyperLendNonHypeValue,
    deriveUsdcBalance,
    netHypeExposure: netExposure,
    netLitExposure: netLitExposure,
    // Cumulative flow tracking for cost socialization
    cumulativeDeposited: vaultData.totalDeposited,
    cumulativeWithdrawn: vaultData.totalWithdrawn,
    newDeposits,
    newWithdrawals,
    entryExitCosts,
  });

  // Keep last 90 days
  if (history.entries.length > 90) {
    history.entries = history.entries.slice(-90);
  }

  saveNavHistory(history);

  // 11. Output for reporting
  const reportableYield = unreportedYield;
  console.log('');
  console.log('='.repeat(60));
  console.log('TO REPORT THIS YIELD:');
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
      deriveShortMtmCost: -deriveOpenShortMarkCost,
      ryskLongMark: ryskLongMarkValue,
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
      sol: solValue,
      lit: litValue,
      ryskStables: ryskStableCollateral,
      hyperLend: hyperLendNonHypeValue,
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
      solana: {
        nativeSol: solanaData.solBalance,
        stakedSol: solanaData.stakedSol,
        totalSol: solanaData.totalSol,
        solPrice: solanaData.solPrice,
        solValue,
        stakeAccounts: solanaData.stakeAccounts,
      },
      hype: {
        spotHypeEvm,
        spotHypeL1,
        ptHypeEquivalent: ptHypeEquiv,
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
