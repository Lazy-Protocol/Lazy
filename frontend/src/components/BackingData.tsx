import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEvmBalances, type TokenBalance } from '@/hooks/useEvmBalances';
import { usePendlePositions, type PendlePTPosition } from '@/hooks/usePendle';
import { useHyperliquidPositions, type HyperliquidPosition } from '@/hooks/useHyperliquid';
import { useLighterPositions, type LighterPosition } from '@/hooks/useLighter';
import { useSolanaPositions } from '@/hooks/useSolana';

const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';
const OPERATOR_ADDRESS = '0xF466ad87c98f50473Cf4Fe32CdF8db652F9E36D6';
const OPERATOR_SOLANA_ADDRESS = '1AxbVeo57DHrMghgWDL5d25j394LDPdwMLEtHHYTkgU';

// Format number with commas and decimals
function formatNumber(value: string | number, decimals = 2): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0.00';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Format USD value
function formatUsd(value: string | number): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '$0.00';
  return `$${formatNumber(Math.abs(num))}`;
}

// Multisig Spot Holdings Component
export function MultisigBalances() {
  const { ethBalances, hyperEvmBalances, isLoading, isError } = useEvmBalances(MULTISIG_ADDRESS);

  if (isLoading) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Spot Holdings</h3>
          <RefreshCw size={16} className="spinning" />
        </div>
        <div className="backing-data-loading">Loading balances...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Spot Holdings</h3>
        </div>
        <div className="backing-data-error">Failed to load balances</div>
      </div>
    );
  }

  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <h3>Spot Holdings</h3>
        <span className="backing-data-badge">EVM</span>
      </div>

      {ethBalances.length === 0 && hyperEvmBalances.length === 0 ? (
        <div className="backing-data-empty">No spot holdings found</div>
      ) : (
        <div className="balance-list">
          {ethBalances.length > 0 && (
            <>
              <div className="balance-chain-label">Ethereum</div>
              {ethBalances.map((bal: TokenBalance) => (
                <div key={`eth-${bal.symbol}`} className="balance-item">
                  <span className="balance-coin">{bal.symbol}</span>
                  <span className="balance-amount">
                    {parseFloat(bal.balanceFormatted) < 0.0001
                      ? '<0.0001'
                      : formatNumber(bal.balanceFormatted, 4)}
                  </span>
                </div>
              ))}
            </>
          )}
          {hyperEvmBalances.length > 0 && (
            <>
              <div className="balance-chain-label">HyperEVM</div>
              {hyperEvmBalances.map((bal: TokenBalance) => (
                <div key={`hyper-${bal.symbol}`} className="balance-item">
                  <span className="balance-coin">{bal.symbol}</span>
                  <span className="balance-amount">
                    {parseFloat(bal.balanceFormatted) < 0.0001
                      ? '<0.0001'
                      : formatNumber(bal.balanceFormatted, 4)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <a
        href={`https://etherscan.io/address/${MULTISIG_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="backing-data-link"
        style={{ marginTop: 'var(--space-sm)' }}
      >
        View on Etherscan <ExternalLink size={12} />
      </a>
    </div>
  );
}

// Pendle PT Holdings Component (auto-discovers across all chains)
export function PendlePositions() {
  const { ptPositions, totalValueUsd, isLoading, isError } = usePendlePositions(MULTISIG_ADDRESS);

  if (isLoading) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Pendle PT</h3>
          <RefreshCw size={16} className="spinning" />
        </div>
        <div className="backing-data-loading">Loading PT positions...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Pendle PT</h3>
          <span className="backing-data-badge">Yield</span>
        </div>
        <div className="backing-data-error">Failed to load positions</div>
      </div>
    );
  }

  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <h3>Pendle PT</h3>
        {totalValueUsd > 0 && (
          <span className="backing-data-value">{formatUsd(totalValueUsd)}</span>
        )}
      </div>

      {ptPositions.length === 0 ? (
        <div className="backing-data-empty">No PT positions</div>
      ) : (
        <div className="pt-list">
          {ptPositions.map((pt: PendlePTPosition, idx: number) => {
            const isExpiringSoon = pt.daysUntilExpiry > 0 && pt.daysUntilExpiry <= 14;

            return (
              <div key={pt.ptAddress || idx} className="pt-item">
                <div className="pt-info">
                  <span className="pt-symbol">{pt.symbol}</span>
                  <span className={`pt-expiry ${isExpiringSoon ? 'expiring-soon' : ''}`}>
                    {pt.chainName} · Expires {pt.expiryFormatted}
                    {pt.daysUntilExpiry > 0 && ` (${pt.daysUntilExpiry}d)`}
                  </span>
                </div>
                <div className="pt-balance-info">
                  <span className="pt-balance">{formatNumber(pt.balance, 2)}</span>
                  {pt.balanceUsd > 0 && (
                    <span className="pt-balance-usd">{formatUsd(pt.balanceUsd)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <a
        href={`https://app.pendle.finance/trade/portfolio/${MULTISIG_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="backing-data-link"
        style={{ marginTop: 'var(--space-sm)' }}
      >
        View on Pendle <ExternalLink size={12} />
      </a>
    </div>
  );
}

// Lighter Positions Component
export function LighterPositions() {
  const { collateral, positions, isLoading, isError } = useLighterPositions(MULTISIG_ADDRESS);

  if (isLoading) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Lighter Perps</h3>
          <RefreshCw size={16} className="spinning" />
        </div>
        <div className="backing-data-loading">Loading positions...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Lighter Perps</h3>
          <span className="backing-data-badge">Multisig</span>
        </div>
        <div className="backing-data-error">Failed to load positions</div>
      </div>
    );
  }

  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <h3>Lighter Perps</h3>
        {collateral > 0 && <span className="backing-data-value">{formatUsd(collateral)}</span>}
      </div>

      {positions.length === 0 ? (
        <div className="backing-data-empty">No positions</div>
      ) : (
        <div className="position-list">
          {positions.map((pos: LighterPosition) => (
            <div key={pos.market} className="position-item">
              <div className="position-info">
                <span className="position-coin">{pos.market}</span>
                <span className={`position-side ${pos.side.toLowerCase()}`}>{pos.side}</span>
              </div>
              <div className="position-details">
                <span className="position-size">{formatNumber(pos.size, 2)}</span>
                <span className="position-entry">@ ${formatNumber(pos.entryPrice, 2)}</span>
              </div>
              <span className={`position-pnl ${pos.unrealizedPnl >= 0 ? 'positive' : 'negative'}`}>
                {pos.unrealizedPnl >= 0 ? '+' : ''}{formatUsd(pos.unrealizedPnl)}
              </span>
            </div>
          ))}
        </div>
      )}

      <a
        href={`https://app.lighter.xyz/explorer/accounts/${MULTISIG_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="backing-data-link"
        style={{ marginTop: 'var(--space-sm)' }}
      >
        View on Lighter <ExternalLink size={12} />
      </a>
    </div>
  );
}

// Hyperliquid Positions Component
export function HyperliquidPositions() {
  const { equity, positions, isLoading, isError } = useHyperliquidPositions(OPERATOR_ADDRESS);

  if (isLoading) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Hyperliquid Perps</h3>
          <RefreshCw size={16} className="spinning" />
        </div>
        <div className="backing-data-loading">Loading positions...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Hyperliquid Perps</h3>
          <span className="backing-data-badge">Operator</span>
        </div>
        <div className="backing-data-error">Failed to load positions</div>
      </div>
    );
  }

  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <h3>Hyperliquid Perps</h3>
        {equity > 0 && <span className="backing-data-value">{formatUsd(equity)}</span>}
      </div>

      {positions.length === 0 ? (
        <div className="backing-data-empty">No positions</div>
      ) : (
        <div className="position-list">
          {positions.map((pos: HyperliquidPosition) => (
            <div key={pos.coin} className="position-item">
              <div className="position-info">
                <span className="position-coin">{pos.coin}</span>
                <span className={`position-side ${pos.side.toLowerCase()}`}>{pos.side}</span>
              </div>
              <div className="position-details">
                <span className="position-size">{formatNumber(pos.size, 2)}</span>
                <span className="position-entry">@ ${formatNumber(pos.entryPrice, 2)}</span>
              </div>
              <span className={`position-pnl ${pos.unrealizedPnl >= 0 ? 'positive' : 'negative'}`}>
                {pos.unrealizedPnl >= 0 ? '+' : ''}{formatUsd(pos.unrealizedPnl)}
              </span>
            </div>
          ))}
        </div>
      )}

      <a
        href={`https://hypurrscan.io/address/${OPERATOR_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="backing-data-link"
        style={{ marginTop: 'var(--space-sm)' }}
      >
        View on Hypurrscan <ExternalLink size={12} />
      </a>
    </div>
  );
}

// Solana Positions Component
export function SolanaPositions() {
  const { data, isLoading, isError } = useSolanaPositions(OPERATOR_SOLANA_ADDRESS);

  if (isLoading) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Solana Holdings</h3>
          <RefreshCw size={16} className="spinning" />
        </div>
        <div className="backing-data-loading">Loading positions...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backing-data-card">
        <div className="backing-data-header">
          <h3>Solana Holdings</h3>
          <span className="backing-data-badge">Operator</span>
        </div>
        <div className="backing-data-error">Failed to load positions</div>
      </div>
    );
  }

  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <h3>Solana Holdings</h3>
        {data.totalValue > 0 && <span className="backing-data-value">{formatUsd(data.totalValue)}</span>}
      </div>

      <div className="balance-list">
        {data.nativeSol > 0.001 && (
          <div className="balance-item">
            <span className="balance-coin">Native SOL</span>
            <span className="balance-amount">{formatNumber(data.nativeSol, 4)}</span>
          </div>
        )}
        {data.stakedSol > 0 && (
          <div className="balance-item">
            <span className="balance-coin">Staked SOL</span>
            <span className="balance-amount">{formatNumber(data.stakedSol, 4)}</span>
          </div>
        )}
        {data.jupiterLendingSol > 0 && (
          <div className="balance-item">
            <span className="balance-coin">Jupiter Lend</span>
            <span className="balance-amount">{formatNumber(data.jupiterLendingSol, 4)} SOL</span>
          </div>
        )}
        <div className="balance-item" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '8px' }}>
          <span className="balance-coin" style={{ fontWeight: 600 }}>Total</span>
          <span className="balance-amount" style={{ fontWeight: 600 }}>{formatNumber(data.totalSol, 4)} SOL</span>
        </div>
      </div>

      <a
        href={`https://solscan.io/account/${OPERATOR_SOLANA_ADDRESS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="backing-data-link"
        style={{ marginTop: 'var(--space-sm)' }}
      >
        View on Solscan <ExternalLink size={12} />
      </a>
    </div>
  );
}

// Combined Live Data Section
export function LiveBackingData() {
  return (
    <section className="section">
      <div className="container">
        <div className="section-header">
          <h2 className="section-title">Live Positions</h2>
          <p className="section-subtitle">Real-time data from onchain wallets</p>
        </div>

        <div className="backing-data-grid">
          <MultisigBalances />
          <PendlePositions />
          <LighterPositions />
          <HyperliquidPositions />
          <SolanaPositions />
        </div>
      </div>
    </section>
  );
}
