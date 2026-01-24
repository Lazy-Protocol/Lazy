// LazyUSDVault ABI - only the functions we need for the frontend
export const vaultAbi = [
  // Read functions
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
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'sharesToUsdc',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'usdcToShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'usdc', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'cooldownPeriod',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'withdrawalQueueHead',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'withdrawalQueueLength',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getWithdrawalRequest',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'requester', type: 'address' },
          { name: 'shares', type: 'uint256' },
          { name: 'requestTimestamp', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'perUserCap',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'globalCap',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'userTotalDeposited',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'pendingWithdrawalShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'userPendingRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'accumulatedYield',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int256' }],
  },
  // Write functions
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usdcAmount', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'requestWithdrawal',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'requestId', type: 'uint256' }],
  },
  // Events
  {
    name: 'Deposit',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'usdcAmount', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'WithdrawalRequested',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'requestId', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'WithdrawalFulfilled',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'usdcAmount', type: 'uint256', indexed: false },
      { name: 'requestId', type: 'uint256', indexed: false },
    ],
  },
] as const;

// Standard ERC20 ABI for USDC
export const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// ReferralRegistry ABI
export const referralRegistryAbi = [
  // Read functions
  {
    name: 'kols',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [
      { name: 'handle', type: 'string' },
      { name: 'feeShareBps', type: 'uint16' },
      { name: 'active', type: 'bool' },
      { name: 'totalReferred', type: 'uint256' },
      { name: 'totalEarned', type: 'uint256' },
    ],
  },
  {
    name: 'handleToAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'handle', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'referrerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'depositor', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getReferrals',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    name: 'getReferralCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getAllKOLs',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    name: 'isKOL',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'resolveHandle',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'handle', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getKOLCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'registrar',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  // Write functions
  {
    name: 'recordReferral',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'depositor', type: 'address' },
      { name: 'referrer', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'recordReferralByHandle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'depositor', type: 'address' },
      { name: 'handle', type: 'string' },
    ],
    outputs: [],
  },
  // Events
  {
    name: 'KOLRegistered',
    type: 'event',
    inputs: [
      { name: 'kol', type: 'address', indexed: true },
      { name: 'handle', type: 'string', indexed: false },
      { name: 'feeShareBps', type: 'uint16', indexed: false },
    ],
  },
  {
    name: 'ReferralRecorded',
    type: 'event',
    inputs: [
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'referrer', type: 'address', indexed: true },
    ],
  },
  {
    name: 'EarningsAccrued',
    type: 'event',
    inputs: [
      { name: 'kol', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

// FeeDistributor ABI
export const feeDistributorAbi = [
  // Read functions
  {
    name: 'previewKOLEarnings',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'previewKOLReferralYield',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [{ name: 'totalYield', type: 'uint256' }],
  },
  {
    name: 'getKOLTotalAUM',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'kol', type: 'address' }],
    outputs: [{ name: 'totalAUM', type: 'uint256' }],
  },
  {
    name: 'nextDistribution',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'timeUntilDistribution',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'canDistribute',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'lastDistribution',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'distributionInterval',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'protocolFeeBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalDistributed',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'lastRecordedAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'depositor', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'treasury',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  // Write functions
  {
    name: 'distribute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'totalKolPayouts', type: 'uint256' }],
  },
  // Events
  {
    name: 'FeesDistributed',
    type: 'event',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'totalFees', type: 'uint256', indexed: false },
      { name: 'kolShare', type: 'uint256', indexed: false },
      { name: 'treasuryShare', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'KOLPaid',
    type: 'event',
    inputs: [
      { name: 'kol', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'referralCount', type: 'uint256', indexed: false },
      { name: 'totalYield', type: 'uint256', indexed: false },
    ],
  },
] as const;
