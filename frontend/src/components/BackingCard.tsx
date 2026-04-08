import { ExternalLink } from 'lucide-react';

interface SpotHolding {
  /** Token symbol */
  symbol: string;
  /** Amount held */
  amount: string;
  /** USD value */
  value: string;
}

interface BackingCardProps {
  /** Token symbol (e.g., "lazyUSD") */
  symbol: string;
  /** Current exchange rate to base asset */
  exchangeRate: string;
  /** Total value locked */
  tvl: string;
  /** Current APR percentage */
  apr: string;
  /** Spot holdings backing the vault */
  spotHoldings?: SpotHolding[];
  /** Link to verification page */
  verifyUrl?: string;
}

/**
 * BackingCard - Token backing verification card
 *
 * Displays token peg status and backing data.
 * lazyUSD is the protocol's unit of account.
 */
export function BackingCard({
  symbol,
  exchangeRate,
  tvl,
  apr,
  spotHoldings = [],
  verifyUrl = '/backing',
}: BackingCardProps) {
  return (
    <div className="backing-card">
      {/* Grid pattern background */}
      <div className="backing-card-grid" />

      <div className="backing-card-content">
        {/* Token header */}
        <div className="backing-card-header">
          <div className="backing-card-symbol">
            <img
              src="/token-64.png"
              alt={symbol}
              className="backing-card-icon"
              width={32}
              height={32}
            />
            <span className="backing-card-name">{symbol}</span>
          </div>
          <span className="backing-card-badge">Verified</span>
        </div>

        {/* Peg status - JetBrains Mono for data emphasis */}
        <div className="backing-card-peg">
          <span className="font-mono text-lg">
            1 {symbol} = {exchangeRate} USDC
          </span>
        </div>

        {/* Stats row */}
        <div className="backing-card-stats">
          <div className="backing-card-stat">
            <span className="backing-card-stat-label">TVL</span>
            <span className="backing-card-stat-value font-mono">{tvl}</span>
          </div>
          <div className="backing-card-stat">
            <span className="backing-card-stat-label">APR</span>
            <span className="backing-card-stat-value font-mono text-yield-gold">{apr}</span>
          </div>
        </div>

        {/* Spot holdings */}
        {spotHoldings.length > 0 && (
          <div className="backing-card-holdings">
            <span className="backing-card-holdings-label">Spot Holdings</span>
            <div className="backing-card-holdings-list">
              {spotHoldings.map((holding) => (
                <div key={holding.symbol} className="backing-card-holding">
                  <span className="backing-card-holding-symbol">{holding.symbol}</span>
                  <div className="backing-card-holding-data">
                    <span className="backing-card-holding-amount font-mono">{holding.amount}</span>
                    <span className="backing-card-holding-value font-mono">{holding.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Verify link */}
        <a href={verifyUrl} className="backing-card-link">
          Verify on-chain <ExternalLink size={14} />
        </a>
      </div>

      <style>{`
        .backing-card {
          position: relative;
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          overflow: hidden;
        }

        .backing-card-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(36, 45, 61, 0.5) 0.5px, transparent 0.5px),
            linear-gradient(90deg, rgba(36, 45, 61, 0.5) 0.5px, transparent 0.5px);
          background-size: 16px 16px;
          pointer-events: none;
        }

        .backing-card-content {
          position: relative;
          padding: 24px;
          z-index: 1;
        }

        .backing-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }

        .backing-card-symbol {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .backing-card-icon {
          border-radius: 4px;
        }

        .backing-card-name {
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 1.25rem;
          color: var(--drift-white, #FAFBFC);
          letter-spacing: -0.03em;
        }

        .backing-card-badge {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.75rem;
          padding: 4px 8px;
          background: rgba(196, 160, 82, 0.15);
          color: var(--yield-gold, #C4A052);
          border-radius: 4px;
        }

        .backing-card-peg {
          margin-bottom: 20px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          text-align: center;
        }

        .backing-card-peg .font-mono {
          font-family: 'JetBrains Mono', monospace;
          color: var(--drift-white, #FAFBFC);
        }

        .backing-card-stats {
          display: flex;
          gap: 16px;
          margin-bottom: 20px;
        }

        .backing-card-stat {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .backing-card-stat-label {
          font-size: 0.75rem;
          color: var(--slate, #64748B);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .backing-card-stat-value {
          font-family: 'JetBrains Mono', monospace;
          font-size: 1rem;
          color: var(--drift-white, #FAFBFC);
        }

        .backing-card-stat-value.text-yield-gold {
          color: var(--yield-gold, #C4A052);
        }

        .backing-card-holdings {
          margin-bottom: 20px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .backing-card-holdings-label {
          display: block;
          font-size: 0.75rem;
          color: var(--slate, #64748B);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 12px;
        }

        .backing-card-holdings-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .backing-card-holding {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .backing-card-holding:last-child {
          border-bottom: none;
          padding-bottom: 0;
        }

        .backing-card-holding-symbol {
          font-family: 'Inter', sans-serif;
          font-weight: 600;
          font-size: 0.875rem;
          color: var(--drift-white, #FAFBFC);
        }

        .backing-card-holding-data {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;
        }

        .backing-card-holding-amount {
          font-size: 0.875rem;
          color: var(--drift-white, #FAFBFC);
        }

        .backing-card-holding-value {
          font-size: 0.75rem;
          color: var(--slate, #64748B);
        }

        .backing-card-link {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 4px;
          font-size: 0.875rem;
          color: var(--drift-white, #FAFBFC);
          text-decoration: none;
          transition: background 150ms ease-out, border-color 150ms ease-out;
        }

        .backing-card-link:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(255, 255, 255, 0.2);
        }

        .font-mono {
          font-family: 'JetBrains Mono', monospace;
        }
      `}</style>
    </div>
  );
}
