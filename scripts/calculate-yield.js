import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================
// Configuration
// ============================================

const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';
const OPERATOR_ADDRESS = '0xF466ad87c98f50473Cf4Fe32CdF8db652F9E36D6';
const OPERATOR_SOLANA_ADDRESS = '1AxbVeo57DHrMghgWDL5d25j394LDPdwMLEtHHYTkgU';
const VAULT_ADDRESS = '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805';

// Jupiter Borrow Vault (SOL collateral, earns interest, can borrow USDC against it)
// Reads on-chain position and applies collateral exchange rate automatically
const JUPITER_VAULT_ACCOUNT = 'Gg2Y3pNYb7aR7dAt35DZfwtupKGSAFMyYewAy8afY8qd';
const JUPITER_VAULT_NFT = 'ECZoMG9irmKbFrqp1FeuZYsQgxt8xdr95bUVE6GHPWRC';
const JUPITER_VAULT_CONFIG = 'FU6R6LFuFUjq1PzquPxBbwvaSs3nxCNWUzi7JntkMZtf'; // Per-position exchange rate
const JUPITER_VAULT_USDC_DEBT = 0; // USDC borrowed (update when borrowing)

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
    weETH: { address: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', decimals: 18 },
  },
  hyperevm: {
    USDC: { address: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', decimals: 6 },
  },
};

// Stablecoin symbols (always valued at $1)
const STABLECOINS = ['USDC', 'USDT', 'DAI'];

// ============================================
// Clients
// ============================================

const ethClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC),
});

const hyperEvmClient = createPublicClient({
  chain: {
    id: 998,
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

async function fetchPendlePositions(address) {
  try {
    // Fetch user positions
    const posResponse = await fetch(
      `https://api-v2.pendle.finance/core/v1/dashboard/positions/database/${address}`
    );

    if (!posResponse.ok) {
      console.warn('Pendle API error:', posResponse.status);
      return { positions: [], totalUsd: 0, totalHypeEquivalent: 0 };
    }

    const posData = await posResponse.json();
    const positions = [];
    let totalUsd = 0;
    let totalHypeEquivalent = 0;

    if (posData?.positions) {
      for (const chainPosition of posData.positions) {
        for (const position of chainPosition.openPositions || []) {
          const ptData = position.pt;
          if (!ptData || parseFloat(ptData.balance) <= 0) continue;

          const marketId = position.marketId;
          const ptBalance = parseFloat(formatUnits(BigInt(ptData.balance), 18));
          const balanceUsd = ptData.valuation || 0;
          totalUsd += balanceUsd;

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
              ptPrice = marketData.pt?.price?.usd || 0;
              underlyingPrice = marketData.accountingAsset?.price?.usd || marketData.underlyingAsset?.price?.usd || 0;

              if (ptPrice > 0 && underlyingPrice > 0) {
                // HYPE equivalent = PT balance × (PT price / underlying price)
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
            balanceUsd,
            hypeEquivalent,
            ptPrice,
            underlyingPrice,
          });
        }
      }
    }

    return { positions, totalUsd, totalHypeEquivalent };
  } catch (e) {
    console.warn('Failed to fetch Pendle positions:', e.message);
    return { positions: [], totalUsd: 0, totalHypeEquivalent: 0 };
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

// ============================================
// Solana Balance & Staking
// ============================================

async function fetchSolanaData(address) {
  try {
    // Fetch SOL price from CoinGecko first
    let solPrice = 0;
    try {
      const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        solPrice = priceData.solana?.usd || 0;
      }
    } catch (e) {
      console.warn('Failed to fetch SOL price:', e.message);
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

    // 3. Fetch Jupiter Lend positions (for jlWSOL underlying SOL value)
    let jupiterLendingSol = 0;
    let jlWsolShares = 0;
    try {
      const jupLendRes = await fetch(`https://lite-api.jup.ag/lend/v1/earn/positions?users=${address}`);
      if (jupLendRes.ok) {
        const jupLendData = await jupLendRes.json();
        for (const position of jupLendData) {
          // jlWSOL token (Jupiter Lend WSOL)
          if (position.token?.address === '2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU') {
            // underlyingAssets is the actual SOL value (9 decimals)
            jupiterLendingSol = parseInt(position.underlyingAssets || 0) / 1e9;
            jlWsolShares = parseInt(position.shares || 0) / 1e9;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch Jupiter Lend positions:', e.message);
    }

    // 4. Fetch token accounts (for JLP and other tokens)
    let jlpBalance = 0;
    let jlpValue = 0;
    try {
      const tokenRes = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'getTokenAccountsByOwner',
          params: [
            address,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' },
          ],
        }),
      });

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        if (tokenData.result?.value) {
          for (const account of tokenData.result.value) {
            const info = account.account?.data?.parsed?.info;
            const mint = info?.mint;
            const amount = parseFloat(info?.tokenAmount?.uiAmount || 0);

            // JLP token mint address
            if (mint === '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4') {
              jlpBalance = amount;
              // Fetch JLP price from Jupiter
              try {
                const jlpPriceRes = await fetch('https://api.jup.ag/price/v2?ids=27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4');
                if (jlpPriceRes.ok) {
                  const jlpPriceData = await jlpPriceRes.json();
                  const jlpPrice = parseFloat(jlpPriceData.data?.['27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4']?.price || 0);
                  jlpValue = jlpBalance * jlpPrice;
                }
              } catch (e) {
                console.warn('Failed to fetch JLP price:', e.message);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch token accounts:', e.message);
    }

    const totalSol = solBalance + stakedSol + jupiterLendingSol;
    const solValue = totalSol * solPrice;
    const totalValue = solValue + jlpValue;

    return {
      solBalance,
      stakedSol,
      jupiterLendingSol,
      jlWsolShares,
      totalSol,
      solPrice,
      solValue,
      jlpBalance,
      jlpValue,
      totalValue,
      stakeAccounts,
    };
  } catch (e) {
    console.warn('Failed to fetch Solana data:', e.message);
    return {
      solBalance: 0,
      stakedSol: 0,
      jupiterLendingSol: 0,
      jlWsolShares: 0,
      totalSol: 0,
      solPrice: 0,
      solValue: 0,
      jlpBalance: 0,
      jlpValue: 0,
      totalValue: 0,
      stakeAccounts: [],
    };
  }
}

// ============================================
// Jupiter Borrow Vault
// ============================================

async function fetchJupiterBorrowVault() {
  try {
    // Fetch both the vault position and config accounts in parallel
    const [positionRes, configRes] = await Promise.all([
      fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [JUPITER_VAULT_ACCOUNT, { encoding: 'base64' }],
        }),
      }),
      fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'getAccountInfo',
          params: [JUPITER_VAULT_CONFIG, { encoding: 'base64' }],
        }),
      }),
    ]);

    if (!positionRes.ok || !configRes.ok) {
      console.warn('Failed to fetch Jupiter vault accounts');
      return { solCollateral: 0, exists: false };
    }

    const [positionData, configData] = await Promise.all([
      positionRes.json(),
      configRes.json(),
    ]);

    const positionInfo = positionData.result?.value;
    const configInfo = configData.result?.value;

    if (!positionInfo) {
      console.warn('Jupiter vault position account not found');
      return { solCollateral: 0, exists: false };
    }

    // Decode position account (contains raw jlWSOL-equivalent amount)
    const positionBuffer = Buffer.from(positionInfo.data[0], 'base64');

    // Raw collateral amount at offset 55 (0x37) - little-endian u64 in lamports
    // This is the internal "shares" representation before exchange rate
    if (positionBuffer.length < 63) {
      console.warn('Jupiter vault position account too small');
      return { solCollateral: 0, exists: false };
    }

    const rawLamports = positionBuffer.readBigUInt64LE(55);
    const rawSol = Number(rawLamports) / 1e9;

    // Get collateral exchange rate from vault config account
    // The rate at offset 99 includes accrued interest (updated periodically by Fluid)
    // May slightly underreport by ~0.03% between updates - conservative for NAV tracking
    let collateralRate = 1.0;
    if (configInfo && configInfo.data) {
      const configBuffer = Buffer.from(configInfo.data[0], 'base64');
      if (configBuffer.length >= 107) {
        const rateRaw = configBuffer.readBigUInt64LE(99);
        collateralRate = Number(rateRaw) / 1e12;
      }
    }

    // Apply exchange rate to get actual SOL value
    const solCollateral = rawSol * collateralRate;

    return {
      solCollateral,
      rawSol, // For debugging
      collateralRate, // For debugging
      usdcDebt: JUPITER_VAULT_USDC_DEBT,
      exists: true,
      vaultAccount: JUPITER_VAULT_ACCOUNT,
      nftMint: JUPITER_VAULT_NFT,
      source: 'on-chain',
    };
  } catch (e) {
    console.warn('Failed to fetch Jupiter borrow vault:', e.message);
    return { solCollateral: 0, exists: false };
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

  // 1. Fetch all data in parallel
  console.log('Fetching data...');

  const [
    multisigEthBalances,
    multisigHyperBalances,
    operatorHyperBalances,
    pendleData,
    lighterData,
    hyperliquidData,
    solanaData,
    jupiterVaultData,
    vaultData,
  ] = await Promise.all([
    fetchEthereumBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(OPERATOR_ADDRESS),
    fetchPendlePositions(MULTISIG_ADDRESS),
    fetchLighterEquity(MULTISIG_ADDRESS),
    fetchHyperliquidEquity(OPERATOR_ADDRESS),
    fetchSolanaData(OPERATOR_SOLANA_ADDRESS),
    fetchJupiterBorrowVault(),
    fetchVaultData(),
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
    } else {
      // Unhedged asset - skip or warn
      console.log(`  ${bal.symbol} (${bal.chain}): ${parseFloat(bal.balance).toFixed(4)} - UNHEDGED (skipped)`);
      continue;
    }

    const usdValue = parseFloat(bal.balance) * price;
    spotTotalUsd += usdValue;
    console.log(`  ${bal.symbol} (${bal.chain}): ${parseFloat(bal.balance).toFixed(4)} × $${price.toFixed(2)} (${priceSource}) = $${usdValue.toFixed(2)}`);
  }
  console.log(`  SPOT TOTAL: $${spotTotalUsd.toFixed(2)}`);

  // 4. Calculate HYPE exposure and hedged/unhedged portions
  // Now considering shorts from BOTH Lighter AND Hyperliquid with their respective entry prices
  console.log('');
  console.log('HYPE EXPOSURE ANALYSIS:');

  // Get current HYPE price
  const hypeCurrentPrice = pendleData.positions[0]?.underlyingPrice || entryPrices['HYPE'] || 0;

  // Calculate total HYPE holdings (spot + PT equivalent)
  let totalHypeHoldings = 0;

  // Spot HYPE
  const spotHype = allSpotBalances
    .filter(b => b.symbol === 'HYPE')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  totalHypeHoldings += spotHype;
  console.log(`  Spot HYPE:        ${spotHype.toFixed(2)} HYPE`);

  // PT HYPE equivalent
  const ptHypeEquiv = pendleData.totalHypeEquivalent || 0;
  totalHypeHoldings += ptHypeEquiv;
  console.log(`  PT HYPE equiv:    ${ptHypeEquiv.toFixed(2)} HYPE`);
  console.log(`  ─────────────────────────`);
  console.log(`  Total holdings:   ${totalHypeHoldings.toFixed(2)} HYPE`);

  // Get HYPE shorts from BOTH venues with their entry prices
  const lighterHypePos = lighterData.positions.find(p => p.market === 'HYPE');
  const lighterHypeShort = Math.abs(parseFloat(lighterHypePos?.size || 0));
  const lighterHypeEntry = parseFloat(lighterHypePos?.entryPrice || 0);

  // Find Hyperliquid HYPE position
  let hyperliquidHypeShort = 0;
  let hyperliquidHypeEntry = 0;
  for (const pos of hyperliquidData.positions) {
    const position = pos.position || pos;
    const coin = position.coin || pos.coin;
    if (coin === 'HYPE') {
      const szi = parseFloat(position.szi || pos.szi || 0);
      if (szi < 0) { // Short position
        hyperliquidHypeShort = Math.abs(szi);
        hyperliquidHypeEntry = parseFloat(position.entryPx || pos.entryPx || 0);
      }
    }
  }

  const totalHypeShort = lighterHypeShort + hyperliquidHypeShort;
  console.log(`  Shorts:`);
  if (lighterHypeShort > 0) {
    console.log(`    Lighter:        ${lighterHypeShort.toFixed(2)} HYPE @ $${lighterHypeEntry.toFixed(2)}`);
  }
  if (hyperliquidHypeShort > 0) {
    console.log(`    Hyperliquid:    ${hyperliquidHypeShort.toFixed(2)} HYPE @ $${hyperliquidHypeEntry.toFixed(2)}`);
  }
  console.log(`  Total short:      ${totalHypeShort.toFixed(2)} HYPE`);

  // Calculate hedged value using each venue's entry price
  // Allocate holdings proportionally to each hedge
  const netExposure = totalHypeHoldings - totalHypeShort;
  let totalHypeValue = 0;

  console.log(`  ─────────────────────────`);

  if (totalHypeShort > 0) {
    // Value hedged portions at their respective entry prices
    const lighterHedgedValue = lighterHypeShort * lighterHypeEntry;
    const hyperliquidHedgedValue = hyperliquidHypeShort * hyperliquidHypeEntry;
    const totalHedgedValue = lighterHedgedValue + hyperliquidHedgedValue;

    console.log(`  Hedged via Lighter:     ${lighterHypeShort.toFixed(2)} × $${lighterHypeEntry.toFixed(2)} = $${lighterHedgedValue.toFixed(2)}`);
    console.log(`  Hedged via Hyperliquid: ${hyperliquidHypeShort.toFixed(2)} × $${hyperliquidHypeEntry.toFixed(2)} = $${hyperliquidHedgedValue.toFixed(2)}`);

    totalHypeValue = totalHedgedValue;

    if (netExposure > 0) {
      const unhedgedValue = netExposure * hypeCurrentPrice;
      console.log(`  Unhedged (asset):       ${netExposure.toFixed(2)} × $${hypeCurrentPrice.toFixed(2)} = $${unhedgedValue.toFixed(2)}`);
      totalHypeValue += unhedgedValue;
    } else if (netExposure < 0) {
      const unhedgedValue = netExposure * hypeCurrentPrice; // negative
      console.log(`  Unhedged (DEBT):        ${Math.abs(netExposure).toFixed(2)} × $${hypeCurrentPrice.toFixed(2)} = $${unhedgedValue.toFixed(2)}`);
      totalHypeValue += unhedgedValue;
    } else {
      console.log(`  Perfectly hedged!`);
    }
  } else {
    // No hedges - all at current price
    totalHypeValue = totalHypeHoldings * hypeCurrentPrice;
    console.log(`  Unhedged (all):   ${totalHypeHoldings.toFixed(2)} × $${hypeCurrentPrice.toFixed(2)} = $${totalHypeValue.toFixed(2)}`);
  }

  console.log(`  ─────────────────────────`);
  console.log(`  HYPE TOTAL:       $${totalHypeValue.toFixed(2)}`);

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
        console.log(`    ${coin} ${side}: ${size.toFixed(4)} @ $${entryPx.toFixed(2)} (${pnlSign}$${unrealizedPnl.toFixed(2)})`);
      }
    }
  }

  // Calculate SOL exposure with Hyperliquid hedge
  console.log('');
  console.log('SOL EXPOSURE ANALYSIS:');
  console.log(`  Native SOL:          ${solanaData.solBalance.toFixed(4)} SOL`);
  console.log(`  Staked SOL:          ${solanaData.stakedSol.toFixed(4)} SOL`);
  if (solanaData.jupiterLendingSol > 0) {
    console.log(`  Jupiter Lend:        ${solanaData.jlWsolShares.toFixed(4)} jlWSOL → ${solanaData.jupiterLendingSol.toFixed(4)} SOL`);
  }
  if (jupiterVaultData.solCollateral > 0) {
    const sourceInfo = jupiterVaultData.source === 'on-chain'
      ? `${jupiterVaultData.rawSol?.toFixed(4)} raw × ${jupiterVaultData.collateralRate?.toFixed(6)} rate`
      : 'override';
    console.log(`  Jupiter Borrow Vault: ${jupiterVaultData.solCollateral.toFixed(4)} SOL (${sourceInfo})`);
  }

  // Include Jupiter vault SOL in total holdings
  const totalSolWithVault = solanaData.totalSol + jupiterVaultData.solCollateral;
  console.log(`  ─────────────────────────`);
  console.log(`  Total holdings:      ${totalSolWithVault.toFixed(4)} SOL`);

  // Find Hyperliquid SOL short
  let hyperliquidSolShort = 0;
  let hyperliquidSolEntry = 0;
  for (const pos of hyperliquidData.positions) {
    const position = pos.position || pos;
    const coin = position.coin || pos.coin;
    if (coin === 'SOL') {
      const szi = parseFloat(position.szi || pos.szi || 0);
      if (szi < 0) { // Short position
        hyperliquidSolShort = Math.abs(szi);
        hyperliquidSolEntry = parseFloat(position.entryPx || pos.entryPx || 0);
      }
    }
  }

  let solValue = 0;
  if (hyperliquidSolShort > 0) {
    console.log(`  Short:               ${hyperliquidSolShort.toFixed(4)} SOL @ $${hyperliquidSolEntry.toFixed(2)} (Hyperliquid)`);

    const hedgedSol = Math.min(totalSolWithVault, hyperliquidSolShort);
    const unhedgedSol = totalSolWithVault - hyperliquidSolShort;

    const hedgedValue = hedgedSol * hyperliquidSolEntry;
    console.log(`  ─────────────────────────`);
    console.log(`  Hedged:              ${hedgedSol.toFixed(4)} × $${hyperliquidSolEntry.toFixed(2)} = $${hedgedValue.toFixed(2)}`);

    solValue = hedgedValue;

    if (unhedgedSol > 0) {
      const unhedgedValue = unhedgedSol * solanaData.solPrice;
      console.log(`  Unhedged (asset):    ${unhedgedSol.toFixed(4)} × $${solanaData.solPrice.toFixed(2)} = $${unhedgedValue.toFixed(2)}`);
      solValue += unhedgedValue;
    } else if (unhedgedSol < 0) {
      const unhedgedValue = unhedgedSol * solanaData.solPrice;
      console.log(`  Unhedged (DEBT):     ${Math.abs(unhedgedSol).toFixed(4)} × $${solanaData.solPrice.toFixed(2)} = $${unhedgedValue.toFixed(2)}`);
      solValue += unhedgedValue;
    }
  } else {
    // No hedge - all at current price
    solValue = totalSolWithVault * solanaData.solPrice;
    console.log(`  No hedge - current:  ${totalSolWithVault.toFixed(4)} × $${solanaData.solPrice.toFixed(2)} = $${solValue.toFixed(2)}`);
  }

  if (solanaData.jlpBalance > 0) {
    console.log(`  JLP Balance:         ${solanaData.jlpBalance.toFixed(4)} JLP = $${solanaData.jlpValue.toFixed(2)}`);
    solValue += solanaData.jlpValue;
  }
  if (solanaData.stakeAccounts.length > 0) {
    console.log('  Stake Accounts:');
    for (const stake of solanaData.stakeAccounts) {
      console.log(`    ${stake.pubkey.slice(0, 8)}...: ${stake.amount.toFixed(4)} SOL`);
    }
  }
  console.log(`  ─────────────────────────`);
  console.log(`  SOL TOTAL:           $${solValue.toFixed(2)}`);

  // 6. Calculate total NAV
  // HYPE value (hedged + unhedged) + ETH (at entry) + USDC + Lighter collateral
  const ethSpot = allSpotBalances
    .filter(b => b.symbol === 'ETH')
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  const ethEntryPrice = entryPrices['ETH'] || 0;
  const ethValue = ethSpot * ethEntryPrice;

  const usdcBalance = allSpotBalances
    .filter(b => STABLECOINS.includes(b.symbol))
    .reduce((sum, b) => sum + parseFloat(b.balance), 0);

  // Subtract Jupiter vault USDC debt if borrowing
  const jupiterDebt = jupiterVaultData.usdcDebt || 0;
  const totalNav = totalHypeValue + ethValue + usdcBalance + lighterData.collateral + hyperliquidCollateral + solValue - jupiterDebt;

  console.log('');
  console.log('='.repeat(60));
  console.log('NAV SUMMARY (Delta-Neutral Valuation):');
  console.log(`  HYPE (hedged):    $${totalHypeValue.toFixed(2)}`);
  console.log(`  SOL (hedged):     $${solValue.toFixed(2)}`);
  if (jupiterVaultData.solCollateral > 0) {
    console.log(`    (incl. Jupiter Borrow Vault: ${jupiterVaultData.solCollateral.toFixed(2)} SOL)`);
  }
  console.log(`  ETH (at entry):   $${ethValue.toFixed(2)}`);
  console.log(`  USDC:             $${usdcBalance.toFixed(2)}`);
  console.log(`  Lighter collat:   $${lighterData.collateral.toFixed(2)}`);
  if (hyperliquidCollateral > 0) {
    console.log(`  Hyperliquid col:  $${hyperliquidCollateral.toFixed(2)}`);
  }
  if (jupiterDebt > 0) {
    console.log(`  Jupiter USDC debt: -$${jupiterDebt.toFixed(2)}`);
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

  console.log('');
  console.log('='.repeat(60));
  console.log('YIELD CALCULATION:');
  console.log(`  True NAV:             $${totalNav.toFixed(2)}`);
  console.log(`  Vault thinks NAV is:  $${vaultData.totalAssets.toFixed(2)}`);
  console.log(`  Gross yield:          $${grossYield.toFixed(2)}`);
  console.log(`  Entry/exit costs:     -$${entryExitCosts.toFixed(2)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  NET UNREPORTED YIELD: $${unreportedYield.toFixed(2)}`);
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
    jupiterVaultSol: jupiterVaultData.solCollateral,
    netHypeExposure: netExposure,
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
  console.log('');
  console.log('='.repeat(60));
  console.log('TO REPORT THIS YIELD:');
  console.log(`  cast send ${VAULT_ADDRESS} "reportYieldAndCollectFees(int256)" ${Math.round(unreportedYield * 1e6)} --rpc-url ${ETH_RPC} --private-key <KEY>`);
  console.log('='.repeat(60));

  return {
    nav: totalNav,
    vaultTotalAssets: vaultData.totalAssets,
    grossYield,
    entryExitCosts,
    unreportedYield,
    sharePrice: vaultData.sharePrice,
    totalSupply: vaultData.totalSupply,
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
      usdc: usdcBalance,
      lighterCollateral: lighterData.collateral,
      hyperliquidEquity: hyperliquidData.equity,
      sol: solValue,
      jupiterVaultSol: jupiterVaultData.solCollateral,
    },
  };
}

// Run
calculateYield().catch(console.error);
