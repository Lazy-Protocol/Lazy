import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link, useLocation } from 'react-router-dom';

const navLinks = [
  { href: '/', label: 'Vaults' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/docs', label: 'Docs' },
];

export function Header() {
  const location = useLocation();

  return (
    <header className="border-b border-lazy-navy-light bg-lazy-navy/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2">
            <div className="flex items-center">
              <span className="text-2xl font-bold text-drift-white">lazy</span>
              <span className="text-yield-gold text-2xl ml-0.5">.</span>
            </div>
          </Link>

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={`text-sm font-medium transition-colors ${
                  location.pathname === link.href
                    ? 'text-yield-gold'
                    : 'text-drift-white/70 hover:text-drift-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Connect Button */}
          <div className="flex items-center">
            <ConnectButton.Custom>
              {({
                account,
                chain,
                openAccountModal,
                openChainModal,
                openConnectModal,
                mounted,
              }) => {
                const ready = mounted;
                const connected = ready && account && chain;

                return (
                  <div
                    {...(!ready && {
                      'aria-hidden': true,
                      style: {
                        opacity: 0,
                        pointerEvents: 'none',
                        userSelect: 'none',
                      },
                    })}
                  >
                    {(() => {
                      if (!connected) {
                        return (
                          <button
                            onClick={openConnectModal}
                            className="bg-yield-gold hover:bg-yield-gold-light text-lazy-navy font-semibold px-4 py-2 rounded-lg transition-colors"
                          >
                            Connect Wallet
                          </button>
                        );
                      }

                      if (chain.unsupported) {
                        return (
                          <button
                            onClick={openChainModal}
                            className="bg-error text-white font-semibold px-4 py-2 rounded-lg"
                          >
                            Wrong Network
                          </button>
                        );
                      }

                      return (
                        <div className="flex items-center gap-3">
                          <button
                            onClick={openChainModal}
                            className="flex items-center gap-2 bg-lazy-navy-light hover:bg-lazy-navy-light/80 px-3 py-2 rounded-lg transition-colors"
                          >
                            {chain.hasIcon && chain.iconUrl && (
                              <img
                                alt={chain.name ?? 'Chain icon'}
                                src={chain.iconUrl}
                                className="w-5 h-5"
                              />
                            )}
                            <span className="text-sm text-drift-white/70">
                              {chain.name}
                            </span>
                          </button>

                          <button
                            onClick={openAccountModal}
                            className="bg-lazy-navy-light hover:bg-lazy-navy-light/80 px-4 py-2 rounded-lg transition-colors"
                          >
                            <span className="text-sm font-medium text-drift-white">
                              {account.displayName}
                            </span>
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                );
              }}
            </ConnectButton.Custom>
          </div>
        </div>
      </div>
    </header>
  );
}
