import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet } from 'wagmi/chains';

// Placeholder addresses - replace with actual deployed addresses
export const CONTRACTS = {
  vault: '0x0000000000000000000000000000000000000001' as `0x${string}`,
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, // Real USDC on mainnet
} as const;

export const config = getDefaultConfig({
  appName: 'Lazy Protocol',
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID', // Get from https://cloud.walletconnect.com
  chains: [mainnet],
  ssr: false,
});
