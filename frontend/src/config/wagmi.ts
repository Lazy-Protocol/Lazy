import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet } from 'wagmi/chains';

// Deployed contract addresses (Ethereum Mainnet)
export const CONTRACTS = {
  vault: '0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805' as `0x${string}`,
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  roleManager: '0x02f8836bbF41e579Ae66B981F538BC015Cd12C7D' as `0x${string}`,
} as const;

export const config = getDefaultConfig({
  appName: 'Lazy Protocol',
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID', // Get from https://cloud.walletconnect.com
  chains: [mainnet],
  ssr: false,
});
