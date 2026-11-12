import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet } from 'wagmi/chains';
import { unstable_connector, fallback } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { http } from 'viem';

export { CONTRACTS } from './contracts';

export const config = getDefaultConfig({
  appName: 'Lazy Protocol',
  projectId: 'dbbf6d65778741aaa414531b7670d4a2',
  chains: [mainnet],
  transports: {
    // Prefer the connected wallet's own RPC (no CORS, no rate limits).
    // Fall back to CORS-friendly public RPCs for pre-connect reads
    // (vault stats on Home page) and non-injected connectors (WalletConnect).
    [mainnet.id]: fallback([
      unstable_connector(injected),
      http('https://ethereum-rpc.publicnode.com'),
      http('https://eth.llamarpc.com'),
      http('https://cloudflare-eth.com'),
      http('https://1rpc.io/eth'),
    ]),
  },
  ssr: false,
});
