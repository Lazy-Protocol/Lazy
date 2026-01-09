import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <div className="footer-logo">
              <svg width="140" height="38" viewBox="0 0 180 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="24" cy="24" r="24" fill="#1a2332"/>
                <path d="M 14 12 L 14 36 L 34 36" stroke="#FAFBFC" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                <circle cx="34" cy="36" r="2.5" fill="#C4A052"/>
                <text x="60" y="34" fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="32" fontWeight="700" fill="#FAFBFC" letterSpacing="-0.03em">lazy</text>
              </svg>
            </div>
            <p>The home for patient capital.</p>
          </div>

          <div className="footer-column">
            <h4>Protocol</h4>
            <ul className="footer-links">
              <li><Link to="/">Vaults</Link></li>
              <li><Link to="/docs">Documentation</Link></li>
              <li><Link to="/backing">Backing</Link></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Community</h4>
            <ul className="footer-links">
              <li><a href="https://t.me/+KKGjFua0yv4zNmFi" target="_blank" rel="noopener noreferrer">Telegram</a></li>
              <li><a href="https://x.com/lazydotxyz" target="_blank" rel="noopener noreferrer">X (Twitter)</a></li>
            </ul>
          </div>

          <div className="footer-column">
            <h4>Developers</h4>
            <ul className="footer-links">
              <li><a href="https://etherscan.io/address/0xd53b68fb4eb907c3c1e348cd7d7bede34f763805" target="_blank" rel="noopener noreferrer">Contracts</a></li>
              <li><a href="https://github.com/sirmoremoney/AYP" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            </ul>
          </div>
        </div>

        <div className="footer-socials">
          <a href="https://x.com/lazydotxyz" className="social-link" aria-label="X (Twitter)" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </a>
          <a href="https://t.me/+KKGjFua0yv4zNmFi" className="social-link" aria-label="Telegram" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
          </a>
          <a href="https://github.com/sirmoremoney/AYP" className="social-link" aria-label="GitHub" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
        </div>

        <div className="footer-bottom">
          <p>&copy; 2026 Lazy Protocol. All rights reserved.</p>
          <Link to="/backing" className="footer-security">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Fully transparent. View backing →
          </Link>
        </div>
      </div>
    </footer>
  );
}
