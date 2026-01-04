import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link, useLocation } from 'react-router-dom';

export function Header() {
  const location = useLocation();

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link to="/" className="nav-logo" style={{ textDecoration: 'none' }}>
          <svg width="140" height="38" viewBox="0 0 180 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="24" fill="#1a2332"/>
            <path d="M 14 12 L 14 36 L 34 36" stroke="#FAFBFC" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <circle cx="34" cy="36" r="2.5" fill="#C4A052"/>
            <text x="60" y="34" fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="32" fontWeight="700" fill="#1a2332" letterSpacing="-0.03em">lazy</text>
          </svg>
        </Link>

        <div className="nav-links">
          <a href="#vaults" className="nav-link">Vaults</a>
          <a href="#how-it-works" className="nav-link">How it works</a>
          <Link to="/docs" className={`nav-link ${location.pathname === '/docs' ? 'active' : ''}`}>
            Docs
          </Link>

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
                          className="btn btn-primary btn-sm"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <path d="M21 15l-5-5L5 21"/>
                          </svg>
                          Connect
                        </button>
                      );
                    }

                    if (chain.unsupported) {
                      return (
                        <button
                          onClick={openChainModal}
                          className="btn btn-sm"
                          style={{ background: 'var(--risk-red)', color: 'white' }}
                        >
                          Wrong Network
                        </button>
                      );
                    }

                    return (
                      <button
                        onClick={openAccountModal}
                        className="btn btn-primary btn-sm"
                      >
                        {account.displayName}
                      </button>
                    );
                  })()}
                </div>
              );
            }}
          </ConnectButton.Custom>
        </div>
      </div>
    </nav>
  );
}
