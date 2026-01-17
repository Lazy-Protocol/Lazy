import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

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
const JUPITER_VAULT_CONFIG = 'FU6R6LFuFUjq1PzquPxBbwvaSs3nxCNWUzi7JntkMZtf'; // Per-position collateral exchange rate
const JUPITER_USDC_DEBT_CONFIG = 'FxiMGrJ2MBatwxKmJPdddS4Gbijvj5QdipoQrmmBAXoQ'; // Global USDC debt exchange rate

const ETH_RPC = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

// Entry/exit cost rates for deploying/unwinding capital
const ENTRY_COST_RATE = 0.00055;  // 0.055% on deposits
const EXIT_COST_RATE = 0.00055;   // 0.055% on withdrawals
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

// Manual adjustments for positions not yet trackable via APIs
// These are added to the NAV calculation
const MANUAL_ADJUSTMENTS = {
  hype: 0,          // No untracked HYPE
  sol: 1.3,         // Untracked SOL position
  usdc: -40,        // Untracked USDC (negative = debt)
};

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
    // Fetch position, collateral config, and debt config accounts in parallel
    const [positionRes, configRes, debtConfigRes] = await Promise.all([
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
      fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'getAccountInfo',
          params: [JUPITER_USDC_DEBT_CONFIG, { encoding: 'base64' }],
        }),
      }),
    ]);

    if (!positionRes.ok || !configRes.ok) {
      console.warn('Failed to fetch Jupiter vault accounts');
      return { solCollateral: 0, exists: false };
    }

    const [positionData, configData, debtConfigData] = await Promise.all([
      positionRes.json(),
      configRes.json(),
      debtConfigRes.json(),
    ]);

    const positionInfo = positionData.result?.value;
    const configInfo = configData.result?.value;
    const debtConfigInfo = debtConfigData.result?.value;

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

    // Raw USDC debt shares at offset 63
    const debtSharesRaw = positionBuffer.readBigUInt64LE(63);
    const rawDebtShares = Number(debtSharesRaw) / 1e6;

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

    // TODO: Get correct borrowExPrice from Fluid protocol
    // The debt config account FxiMGrJ2... has a rate at offset 29, but it gives ~$100,322
    // instead of the correct ~$100,000.6. Need to find the correct Fluid formula.
    // For now, using a placeholder rate that gives approximately correct results.
    // Once Fluid formula is known, update this calculation.
    const TEMP_DEBT_RATE = 12.913334577369; // = 100000 / 7743.979636 (principal / rawShares)

    // Apply exchange rates to get actual values
    const solCollateral = rawSol * collateralRate;
    const usdcDebt = rawDebtShares * TEMP_DEBT_RATE;

    return {
      solCollateral,
      rawSol, // For debugging
      collateralRate, // For debugging
      usdcDebt,
      rawDebtShares, // For debugging
      debtRate: TEMP_DEBT_RATE, // For debugging (TODO: replace with actual Fluid rate)
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
    hyperliquidData,
    solanaData,
    jupiterVaultData,
    vaultData,
  ] = await Promise.all([
    fetchEthereumBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(MULTISIG_ADDRESS),
    fetchHyperEvmBalances(OPERATOR_ADDRESS),
    fetchPendlePositions(MULTISIG_ADDRESS, usdcPrice),
    fetchLighterEquity(MULTISIG_ADDRESS),
    fetchLighterSpotAssets(),
    fetchHyperliquidEquity(OPERATOR_ADDRESS),
    fetchSolanaData(OPERATOR_SOLANA_ADDRESS, usdcPrice),
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

  // Manual HYPE adjustment (untracked positions)
  const manualHype = MANUAL_ADJUSTMENTS.hype || 0;
  if (manualHype !== 0) {
    totalHypeHoldings += manualHype;
    console.log(`  Manual (untracked): ${manualHype.toFixed(2)} HYPE`);
  }
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
  let totalSolWithVault = solanaData.totalSol + jupiterVaultData.solCollateral;

  // Manual SOL adjustment (untracked positions)
  const manualSol = MANUAL_ADJUSTMENTS.sol || 0;
  if (manualSol !== 0) {
    totalSolWithVault += manualSol;
    console.log(`  Manual (untracked):  ${manualSol.toFixed(4)} SOL`);
  }
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

  // Calculate LIT exposure with Hyperliquid hedge
  console.log('');
  console.log('LIT EXPOSURE ANALYSIS:');
  const litSpot = lighterSpotData.litBalance;
  console.log(`  Spot (Lighter):      ${litSpot.toFixed(4)} LIT`);

  // Find Hyperliquid LIT short
  let hyperliquidLitShort = 0;
  let hyperliquidLitEntry = 0;
  let litCurrentPrice = 0;
  for (const pos of hyperliquidData.positions) {
    const position = pos.position || pos;
    const coin = position.coin || pos.coin;
    if (coin === 'LIT') {
      const szi = parseFloat(position.szi || pos.szi || 0);
      if (szi < 0) { // Short position
        hyperliquidLitShort = Math.abs(szi);
        hyperliquidLitEntry = parseFloat(position.entryPx || pos.entryPx || 0);
        // Derive current price from entry and PnL
        const pnl = parseFloat(position.unrealizedPnl || pos.unrealizedPnl || 0);
        litCurrentPrice = hyperliquidLitEntry - (pnl / hyperliquidLitShort);
      }
    }
  }

  let litValue = 0;
  if (hyperliquidLitShort > 0) {
    console.log(`  Short (Hyperliquid): ${hyperliquidLitShort.toFixed(4)} LIT @ $${hyperliquidLitEntry.toFixed(4)}`);
    console.log(`  ─────────────────────────`);

    const hedgedLit = Math.min(litSpot, hyperliquidLitShort);
    const unhedgedLit = litSpot - hyperliquidLitShort;

    const hedgedValue = hedgedLit * hyperliquidLitEntry;
    console.log(`  Hedged:              ${hedgedLit.toFixed(4)} × $${hyperliquidLitEntry.toFixed(4)} = $${hedgedValue.toFixed(2)}`);

    litValue = hedgedValue;

    if (unhedgedLit > 0) {
      const unhedgedValue = unhedgedLit * litCurrentPrice;
      console.log(`  Unhedged (asset):    ${unhedgedLit.toFixed(4)} × $${litCurrentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
      litValue += unhedgedValue;
    } else if (unhedgedLit < 0) {
      const unhedgedValue = unhedgedLit * litCurrentPrice;
      console.log(`  Unhedged (DEBT):     ${Math.abs(unhedgedLit).toFixed(4)} × $${litCurrentPrice.toFixed(4)} = $${unhedgedValue.toFixed(2)}`);
      litValue += unhedgedValue;
    } else {
      console.log(`  Perfectly hedged!`);
    }
  } else if (litSpot > 0) {
    // No hedge - would need current price from an API
    console.log(`  No hedge - unhedged spot position`);
    litValue = 0; // Can't value without price
  }

  console.log(`  ─────────────────────────`);
  console.log(`  LIT TOTAL:           $${litValue.toFixed(2)}`);

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

  // Add Lighter spot USDC
  const lighterUsdcBalance = lighterSpotData.usdcBalance || 0;

  // Manual USDC adjustment (untracked positions, can be negative for debt)
  const manualUsdc = MANUAL_ADJUSTMENTS.usdc || 0;
  const totalUsdcBalance = usdcBalance + lighterUsdcBalance + manualUsdc;

  // Subtract Jupiter vault USDC debt if borrowing
  const jupiterDebt = jupiterVaultData.usdcDebt || 0;
  const totalNav = totalHypeValue + ethValue + totalUsdcBalance + lighterData.collateral + hyperliquidCollateral + solValue + litValue - jupiterDebt;

  console.log('');
  console.log('='.repeat(60));
  console.log('NAV SUMMARY (Delta-Neutral Valuation):');
  console.log(`  HYPE (hedged):    $${totalHypeValue.toFixed(2)}`);
  console.log(`  SOL (hedged):     $${solValue.toFixed(2)}`);
  if (jupiterVaultData.solCollateral > 0) {
    console.log(`    (incl. Jupiter Borrow Vault: ${jupiterVaultData.solCollateral.toFixed(2)} SOL)`);
  }
  console.log(`  LIT (hedged):     $${litValue.toFixed(2)}`);
  console.log(`  ETH (at entry):   $${ethValue.toFixed(2)}`);
  console.log(`  USDC:             $${totalUsdcBalance.toFixed(2)}`);
  if (lighterUsdcBalance > 0) {
    console.log(`    (incl. Lighter spot: $${lighterUsdcBalance.toFixed(2)})`);
  }
  if (manualUsdc !== 0) {
    console.log(`    (incl. manual adj: $${manualUsdc.toFixed(2)})`);
  }
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
    litValue,
    jupiterVaultSol: jupiterVaultData.solCollateral,
    netHypeExposure: netExposure,
    netLitExposure: litSpot - hyperliquidLitShort,
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
      jupiterVaultSol: jupiterVaultData.solCollateral,
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
        jupiterLendSol: solanaData.jupiterLendingSol,
        jupiterBorrowVault: {
          solCollateral: jupiterVaultData.solCollateral,
          rawSol: jupiterVaultData.rawSol,
          collateralRate: jupiterVaultData.collateralRate,
          usdcDebt: jupiterVaultData.usdcDebt || 0,
        },
        totalSol: totalSolWithVault,
        solPrice: solanaData.solPrice,
        solValue,
        stakeAccounts: solanaData.stakeAccounts,
      },
      hype: {
        spotHype,
        ptHypeEquivalent: ptHypeEquiv,
        totalHoldings: totalHypeHoldings,
        lighterShort: { size: lighterHypeShort, entryPrice: lighterHypeEntry },
        hyperliquidShort: { size: hyperliquidHypeShort, entryPrice: hyperliquidHypeEntry },
        totalShort: totalHypeShort,
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
        spotBalance: litSpot,
        hyperliquidShort: { size: hyperliquidLitShort, entryPrice: hyperliquidLitEntry },
        netExposure: litSpot - hyperliquidLitShort,
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
