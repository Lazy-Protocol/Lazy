// Decimal precision
export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
export const PRICE_DECIMALS = 18;

// Time constants
export const SECONDS_PER_DAY = 86400;

// Display formatting
export const MAX_DISPLAY_DECIMALS = 4;
export const MIN_DISPLAY_DECIMALS = 2;

// URLs
export const ETHERSCAN_BASE_URL = 'https://etherscan.io';
export const ETHERSCAN_TX_URL = (hash: string) => `${ETHERSCAN_BASE_URL}/tx/${hash}`;
export const ETHERSCAN_ADDRESS_URL = (address: string) => `${ETHERSCAN_BASE_URL}/address/${address}`;

// Protocol info
export const PROTOCOL_NAME = 'Lazy Protocol';
export const VAULT_SYMBOL = 'lazyUSD';
