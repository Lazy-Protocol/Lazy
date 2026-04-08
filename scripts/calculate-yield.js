import { createPublicClient, http, formatUnits, createWalletClient } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

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
  },
};

// Stablecoin symbols (always valued at $1)
const STABLECOINS = ['USDC', 'USDT', 'USDT0', 'DAI'];


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
    prices[pos.market] = parseFloat(pos.entryPrice);
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

  if (netShort > 0) {
    // Value the hedged spot at the short entry prices (pro-rata if multiple shorts)
    // Perp longs reduce the net short but their value is in their own collateral/PnL
    const netShortValue = shorts.reduce((sum, s) => sum + s.size * s.entryPrice, 0)
      - longs.reduce((sum, l) => sum + l.size * l.entryPrice, 0);
    const hedgedSpot = Math.min(totalHoldings, netShort);
    const hedgedValue = hedgedSpot / netShort * netShortValue;
    console.log(`  Hedged:${' '.repeat(Math.max(0, 14 - symbol.length))}${hedgedSpot.toFixed(2)} × avg $${(netShortValue / netShort).toFixed(4)} = $${hedgedValue.toFixed(2)}`);
    totalValue += hedgedValue;

    if (netExposure > 0) {
      const unhedgedValue = netExposure * currentPrice;
      console.log(`  Unhedged (asset):${' '.repeat(Math.max(0, 8 - symbol.length))}${netExposure.toFixed(2)} × $${currentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
      totalValue += unhedgedValue;
    } else if (netExposure < 0) {
      const unhedgedValue = netExposure * currentPrice;
      console.log(`  Unhedged (DEBT):${' '.repeat(Math.max(0, 9 - symbol.length))}${Math.abs(netExposure).toFixed(2)} × $${currentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
      totalValue += unhedgedValue;
    } else {
      console.log(`  Perfectly hedged!`);
    }
  } else if (totalHoldings > 0 && currentPrice > 0) {
    totalValue = totalHoldings * currentPrice;
    console.log(`  No hedge - current:  ${totalHoldings.toFixed(4)} × $${currentPrice.toFixed(2)} = $${totalValue.toFixed(2)}`);
  } else if (totalHoldings > 0) {
    console.log(`  No hedge - no price available`);
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

// Helper: extract short position for a market from Lighter positions array
function findLighterShort(positions, market) {
  const pos = positions.find(p => p.market === market);
  if (!pos) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
  const size = parseFloat(pos.size || 0);
  if (pos.side !== 'short' && size >= 0) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
  return {
    size: Math.abs(size),
    entryPrice: parseFloat(pos.entryPrice || 0),
    unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
  };
}

// Helper: extract long position for a market from Lighter positions array
function findLighterLong(positions, market) {
  const pos = positions.find(p => p.market === market);
  if (!pos) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
  const size = parseFloat(pos.size || 0);
  if (pos.side !== 'long' && size <= 0) return { size: 0, entryPrice: 0, unrealizedPnl: 0 };
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

async function fetchLighterEquity(address) {
  try {
    // Fetch account data (collateral)
    const accountResponse = await fetch(
      `https://mainnet.zklighter.elliot.ai/api/v1/accountsByL1Address?l1_address=${address}`
    );

    let totalCollateral = 0;
    let accountIndex = LIGHTER_ACCOUNT_INDEX;

    if (accountResponse.ok) {
      const accountData = await accountResponse.json();
      const subAccounts = accountData.sub_accounts || [];

      for (const account of subAccounts) {
        totalCollateral += parseFloat(account.collateral || 0);
        if (account.index) {
          accountIndex = account.index;
        }
      }
    }

    // Fetch positions with unrealized PnL from explorer API
    const positionsResponse = await fetch(
      `https://explorer.elliot.ai/api/accounts/${accountIndex}/positions`
    );

    let unrealizedPnl = 0;
    const positions = [];

    if (positionsResponse.ok) {
      const positionsData = await positionsResponse.json();

      for (const [marketIdx, position] of Object.entries(positionsData.positions || {})) {
        const pnl = parseFloat(position.pnl || 0);
        unrealizedPnl += pnl;

        positions.push({
          market: LIGHTER_MARKETS[marketIdx] || `Market ${marketIdx}`,
          side: position.side,
          size: position.size,
          entryPrice: position.entry_price,
          unrealizedPnl: pnl,
        });
      }
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
    let totalCollateralWhype = 0;

    const collateralDecimals = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 6;
      if (lower === HYPEREVM_USDC.toLowerCase()) return 6;
      if (lower === WHYPE_ADDRESS.toLowerCase()) return 18;
      return 18; // default
    };

    const collateralSymbol = (addr) => {
      const lower = addr.toLowerCase();
      if (lower === USDT0_ADDRESS.toLowerCase()) return 'USDT0';
      if (lower === HYPEREVM_USDC.toLowerCase()) return 'USDC';
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
      totalCollateralWhype,
      totalCollateral: totalCollateralUsdt0 + totalCollateralUsdc, // USD-denominated portion
      positions,
      vaultCount: count,
    };
  } catch (e) {
    console.warn('Failed to fetch Rysk positions:', e.message);
    return { totalCollateralUsdt0: 0, totalCollateralUsdc: 0, totalCollateralWhype: 0, totalCollateral: 0, positions: [], vaultCount: 0 };
  }
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
  USDC:  { address: '0x744E4f26ee30213989216E1632D9BE3547C4885b', decimals: 6, underlying: HYPEREVM_USDC },
};

const HYPERLEND_DEBT_TOKENS = {
  WHYPE: { address: '0x747d0d4Ba0a2083651513cd008deb95075683e82', decimals: 18 },
  USDT0: { address: '0x1EF897622D62335e7FC88Fb0605FbBa28eC0b01d', decimals: 6 },
  USDC:  { address: '0xD612513cB3b2C52abCD6d4b338374C09AdA4657d', decimals: 6 },
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

async function fetchDerivePositions() {
  if (!DERIVE_WALLET || !DERIVE_SESSION_KEY || !DERIVE_SUBACCOUNT_ID) {
    return { usdcBalance: 0, positions: [], openOrders: [] };
  }

  try {
    const headers = await deriveAuthHeaders();
    if (!headers) return { usdcBalance: 0, positions: [], openOrders: [] };

    const [collateralsRes, positionsRes, ordersRes] = await Promise.all([
      fetch(`${DERIVE_API}/private/get_collaterals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subaccount_id: DERIVE_SUBACCOUNT_ID }),
      }),
      fetch(`${DERIVE_API}/private/get_positions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subaccount_id: DERIVE_SUBACCOUNT_ID }),
      }),
      fetch(`${DERIVE_API}/private/get_open_orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subaccount_id: DERIVE_SUBACCOUNT_ID }),
      }),
    ]);

    const collaterals = (await collateralsRes.json()).result || {};
    const positionsData = (await positionsRes.json()).result || {};
    const ordersData = (await ordersRes.json()).result || {};

    // Parse USDC balance from collaterals
    let usdcBalance = 0;
    const collateralList = collaterals.collaterals || [];
    if (Array.isArray(collateralList)) {
      for (const c of collateralList) {
        if (c.asset_name === 'USDC') {
          usdcBalance += parseFloat(c.amount || 0);
        }
      }
    }

    // Parse option positions (non-zero amounts only)
    const positions = [];
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

    // Parse open orders
    const openOrders = [];
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

    return { usdcBalance, positions, openOrders };
  } catch (e) {
    console.warn('Failed to fetch Derive positions:', e.message);
    return { usdcBalance: 0, positions: [], openOrders: [] };
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
    pendleData,
    lighterData,
    lighterSpotData,
    lighterStakedData,
    hyperliquidData,
    solanaData,
    vaultData,
    hyperliquidSpotData,
    ryskData,
    hyperLendData,
    deriveData,
  ] = await Promise.all([
    fetchEthereumBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(OPERATOR_ADDRESS),
    fetchPendlePositions(MULTISIG_ADDRESS, usdcPrice),
    fetchLighterEquity(MULTISIG_ADDRESS),
    fetchLighterSpotAssets(),
    fetchLighterStakedLIT(),
    fetchHyperliquidEquity(OPERATOR_ADDRESS),
    fetchSolanaData(OPERATOR_SOLANA_ADDRESS, usdcPrice),
    fetchVaultData(),
    fetchHyperliquidSpot(OPERATOR_ADDRESS),
    fetchRyskPositions(OPERATOR_ADDRESS),
    fetchHyperLendPositions(OPERATOR_ADDRESS),
    fetchDerivePositions(),
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
  const ryskWhype = ryskData.totalCollateralWhype || 0;
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
  let hypeCurrentPrice = pendleData.positions[0]?.underlyingPrice || entryPrices['HYPE'] || derivePriceFromShort(hlHypeShort);

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
  if (ryskData.positions.length > 0) {
    if (ryskData.totalCollateralUsdt0 > 0) {
      console.log(`  USDT0 collateral:  $${ryskData.totalCollateralUsdt0.toFixed(2)}`);
    }
    if (ryskData.totalCollateralUsdc > 0) {
      console.log(`  USDC collateral:   $${ryskData.totalCollateralUsdc.toFixed(2)}`);
    }
    if (ryskData.totalCollateralWhype > 0) {
      console.log(`  WHYPE collateral:  ${ryskData.totalCollateralWhype.toFixed(4)} HYPE`);
    }
    console.log(`  Positions (${ryskData.positions.length} vaults):`);
    for (const pos of ryskData.positions) {
      console.log(`    ${pos.type} $${pos.strike.toFixed(0)} exp ${pos.expiry}: ${pos.contracts.toFixed(1)} contracts (${pos.collateral.toFixed(2)} ${pos.collateralSymbol})`);
    }
  } else {
    console.log(`  No Rysk positions (${ryskData.vaultCount} vaults checked)`);
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
    console.log(`  USDC balance:      $${deriveData.usdcBalance.toFixed(2)}`);
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
  const ethSpot = allSpotBalances
    .filter(b => b.symbol === 'ETH')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  const ethEntryPrice = entryPrices['ETH'] || 0;
  const ethValue = ethSpot * ethEntryPrice;

  const usdcBalance = allSpotBalances
    .filter(b => STABLECOINS.includes(b.symbol))
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);

  // Add Lighter spot USDC
  const lighterUsdcBalance = lighterSpotData.usdcBalance || 0;

  // Add Hyperliquid spot USDC
  const hyperliquidUsdcBalance = hyperliquidSpotData.usdcBalance || 0;

  const totalUsdcBalance = usdcBalance + lighterUsdcBalance + hyperliquidUsdcBalance;

  // Rysk stable collateral (USDT0 + USDC at $1). WHYPE is counted in HYPE exposure above.
  const ryskStableCollateral = ryskData.totalCollateral;

  // HyperLend: WHYPE is counted in HYPE exposure. Only add non-WHYPE supplies here.
  const hyperLendStableValue = (hyperLendData.supplies['USDT0'] || 0) + (hyperLendData.supplies['USDC'] || 0);
  // Subtract any debts
  const hyperLendDebtValue = Object.values(hyperLendData.debts).reduce((sum, v) => sum + v, 0);
  const hyperLendNonHypeValue = hyperLendStableValue - hyperLendDebtValue;

  // Derive.xyz: USDC collateral at $1
  const deriveUsdcBalance = deriveData.usdcBalance;

  const totalNav = totalHypeValue + ethValue + totalUsdcBalance + lighterData.collateral + hyperliquidCollateral + solValue + litValue + ryskStableCollateral + hyperLendNonHypeValue + deriveUsdcBalance;

  console.log('');
  console.log('='.repeat(60));
  console.log('NAV SUMMARY (Delta-Neutral Valuation):');
  console.log(`  HYPE (hedged):    $${totalHypeValue.toFixed(2)}`);
  console.log(`  SOL (hedged):     $${solValue.toFixed(2)}`);
  console.log(`  LIT (hedged):     $${litValue.toFixed(2)}`);
  console.log(`  ETH (at entry):   $${ethValue.toFixed(2)}`);
  console.log(`  USDC:             $${totalUsdcBalance.toFixed(2)}`);
  if (lighterUsdcBalance > 0) {
    console.log(`    (incl. Lighter spot: $${lighterUsdcBalance.toFixed(2)})`);
  }
  if (hyperliquidUsdcBalance > 0) {
    console.log(`    (incl. Hyperliquid spot: $${hyperliquidUsdcBalance.toFixed(2)})`);
  }
  console.log(`  Lighter collat:   $${lighterData.collateral.toFixed(2)}`);
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

  // Calculate unrealized options premium from open Derive positions.
  // Short positions have collected premium (avg_price * abs(amount)) that could
  // be lost at settlement if the option goes ITM. Conservative approach: exclude
  // this premium from safe-to-report yield until positions expire.
  let deriveOpenPremium = 0;
  for (const pos of deriveData.positions) {
    if (pos.amount < 0) {
      // SHORT position: premium collected = abs(amount) * averagePrice
      deriveOpenPremium += Math.abs(pos.amount) * pos.averagePrice;
    }
  }
  const conservativeYield = unreportedYield - deriveOpenPremium;

  console.log('');
  console.log('='.repeat(60));
  console.log('YIELD CALCULATION:');
  console.log(`  True NAV:             $${totalNav.toFixed(2)}`);
  console.log(`  Vault thinks NAV is:  $${vaultData.totalAssets.toFixed(2)}`);
  console.log(`  Gross yield:          $${grossYield.toFixed(2)}`);
  console.log(`  Entry/exit costs:     -$${entryExitCosts.toFixed(2)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  NET UNREPORTED YIELD: $${unreportedYield.toFixed(2)}`);
  if (deriveOpenPremium > 0) {
    console.log(`  ─────────────────────────`);
    console.log(`  Open options premium: -$${deriveOpenPremium.toFixed(2)} (excluded until expiry)`);
    console.log(`  SAFE TO REPORT:       $${conservativeYield.toFixed(2)}`);
  }
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
    usdcBalance,
    lighterCollateral: lighterData.collateral,
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
  const reportableYield = deriveOpenPremium > 0 ? conservativeYield : unreportedYield;
  console.log('');
  console.log('='.repeat(60));
  console.log('TO REPORT THIS YIELD:');
  if (deriveOpenPremium > 0) {
    console.log(`  (Conservative: excludes $${deriveOpenPremium.toFixed(2)} open options premium)`);
  }
  console.log(`  cast send ${VAULT_ADDRESS} "reportYieldAndCollectFees(int256)" ${Math.round(reportableYield * 1e6)} --rpc-url ${ETH_RPC} --private-key <KEY>`);
  console.log('='.repeat(60));

  return {
    nav: totalNav,
    vaultTotalAssets: vaultData.totalAssets,
    grossYield,
    entryExitCosts,
    unreportedYield,
    deriveOpenPremium,
    conservativeYield: reportableYield,
    sharePrice: vaultData.sharePrice,
    totalSupply: vaultData.totalSupply,
    accumulatedYield: vaultData.accumulatedYield,
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
      usdc: totalUsdcBalance,
      lighterCollateral: lighterData.collateral,
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
      lighter: {
        collateral: lighterData.collateral,
        unrealizedPnl: lighterData.unrealizedPnl,
        equity: lighterData.equity,
        positions: lighterData.positions,
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
        totalCollateralWhype: ryskData.totalCollateralWhype,
        positions: ryskData.positions,
        vaultCount: ryskData.vaultCount,
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
        positions: deriveData.positions,
        openOrders: deriveData.openOrders,
      },
    },
  };
}

// Run with snapshot prompt
async function main() {
  const result = await calculateYield();

  console.log('');
  const answer = await promptUser('Save snapshot after yield report? (y/n): ');

  if (answer === 'y' || answer === 'yes') {
    const snapshot = {
      timestamp: new Date().toISOString(),
      yieldReported: result.unreportedYield,
      nav: result.nav,
      sharePrice: result.sharePrice,
      totalSupply: result.totalSupply,
      accumulatedYield: result.accumulatedYield,
      holdings: result.holdings,
      breakdown: result.breakdown,
    };
    saveYieldSnapshot(snapshot);
  } else {
    console.log('Snapshot not saved.');
  }
}

main().catch(console.error);
