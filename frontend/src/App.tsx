import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { Toaster } from 'react-hot-toast';

import { config } from '@/config/wagmi';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Home } from '@/pages/Home';
import { Portfolio } from '@/pages/Portfolio';
import { Docs } from '@/pages/Docs';
import Backing from '@/pages/Backing';

import '@rainbow-me/rainbowkit/styles.css';

const queryClient = new QueryClient();

// Custom theme matching Lazy Protocol brand
const customTheme = darkTheme({
  accentColor: '#C4A052', // yield-gold
  accentColorForeground: '#1a2332', // lazy-navy
  borderRadius: 'large',
});

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={customTheme}>
          <BrowserRouter>
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<Home />} />
                  <Route path="portfolio" element={<Portfolio />} />
                  <Route path="backing" element={<Backing />} />
                  <Route path="docs" element={<Docs />} />
                </Route>
              </Routes>
            </ErrorBoundary>
          </BrowserRouter>
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#243044',
                color: '#FAFBFC',
                border: '1px solid #1a2332',
              },
              success: {
                iconTheme: {
                  primary: '#22c55e',
                  secondary: '#FAFBFC',
                },
              },
              error: {
                iconTheme: {
                  primary: '#ef4444',
                  secondary: '#FAFBFC',
                },
              },
            }}
          />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
