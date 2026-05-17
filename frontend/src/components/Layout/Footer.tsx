import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

const VAULT_ADDRESS = '0xd53b68fb4eb907c3c1e348cd7d7bede34f763805';

export function Footer() {
  return (
    <footer className="ftr">
      <div className="container ftr-inner">
        <div className="ftr-top">
          {/* Brand block */}
          <header className="ftr-masthead">
            <div className="ftr-mark">
              <span className="ftr-mark-dot" aria-hidden />
              <span>Be lazy</span>
            </div>

            <h2 className="ftr-wordmark">lazy</h2>
            <p className="ftr-tagline">
              The home for <em>patient capital.</em>
            </p>
          </header>

          {/* Columns */}
          <nav className="ftr-cols" aria-label="Footer navigation">
          <div className="ftr-col">
            <div className="ftr-col-label">Pages</div>
            <ul className="ftr-col-list">
              <li><Link to="/">Vault</Link></li>
              <li><Link to="/docs">Documentation</Link></li>
              <li><Link to="/backing">Backing</Link></li>
              <li><Link to="/security">Security</Link></li>
            </ul>
          </div>

          <div className="ftr-col">
            <div className="ftr-col-label">Community</div>
            <ul className="ftr-col-list">
              <li>
                <a href="https://t.me/+KKGjFua0yv4zNmFi" target="_blank" rel="noopener noreferrer">
                  <span>Telegram</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
              <li>
                <a href="https://x.com/lazydotxyz" target="_blank" rel="noopener noreferrer">
                  <span>X</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
            </ul>
          </div>

          <div className="ftr-col">
            <div className="ftr-col-label">Code</div>
            <ul className="ftr-col-list">
              <li>
                <a
                  href={`https://etherscan.io/address/${VAULT_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>Contract</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Lazy-Protocol/lazy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>GitHub</span>
                  <ArrowUpRight size={11} />
                </a>
              </li>
            </ul>
          </div>
          </nav>
        </div>

        {/* Bottom */}
        <div className="ftr-bottom">
          <span className="ftr-copy">&copy; 2026 Lazy Protocol</span>
          <span className="ftr-closer">Don't trust. Verify.</span>
        </div>
      </div>
    </footer>
  );
}
