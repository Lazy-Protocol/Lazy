import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useVaultStats, useUserData, formatUsdc, formatShares } from '@/hooks/useVault';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { DepositModal } from '@/components/DepositModal';
import { WithdrawModal } from '@/components/WithdrawModal';
import { VaultCertificate } from '@/components/VaultCertificate';
import { TimeMachine } from '@/components/TimeMachine';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { Link } from 'react-router-dom';
import { Shield, Clock, Eye, Activity, ArrowRight } from 'lucide-react';

// Vault launch date for "Days Live" calculation
const VAULT_LAUNCH = new Date('2026-01-07T00:00:00Z');

export function Home() {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showCertificate, setShowCertificate] = useState(false);
  const { address, isConnected } = useAccount();
  const { totalAssets, accumulatedYield } = useVaultStats();
  const { shareBalance, usdcValue, totalDeposited } = useUserData(address);
  const { data: protocolStats } = useProtocolStats();

  // Prefer live on-chain values. Fall back to the GitHub-published stats.json only
  // while the wagmi reads are loading, so stale stats.json never overrides fresh chain data.
  const tvlValue = totalAssets !== undefined
    ? Number(totalAssets) / 1e6
    : protocolStats?.formatted?.tvl
      ? Number(protocolStats.formatted.tvl)
      : 0;

  const yieldValue = accumulatedYield !== undefined && accumulatedYield > 0n
    ? Number(accumulatedYield) / 1e6
    : protocolStats?.formatted?.accumulatedYield
      ? Number(protocolStats.formatted.accumulatedYield)
      : 0;

  const aprValue = protocolStats?.apr ? Number(protocolStats.apr) : 0;
  const apr30dValue = typeof protocolStats?.apr30d === 'number' ? Number(protocolStats.apr30d) : null;
  const aprLabel = protocolStats?.aprSource === 'static'
    ? 'Target APR'
    : protocolStats?.aprPeriod === '7d'
      ? '7d Realised APR'
      : 'Realised APR';

  // Calculate days since vault launch
  const daysLive = Math.max(0, Math.floor((Date.now() - VAULT_LAUNCH.getTime()) / (1000 * 60 * 60 * 24)));

  // Legacy string display for vault cards
  const tvlDisplay = tvlValue > 0
    ? `$${tvlValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '...';

  const location = useLocation();

  // Handle hash scroll on navigation
  useEffect(() => {
    if (location.hash) {
      const element = document.getElementById(location.hash.slice(1));
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
    }
  }, [location]);

  // Calculate user earnings
  const earnings = usdcValue && totalDeposited && usdcValue > totalDeposited
    ? usdcValue - totalDeposited
    : 0n;

  return (
    <>
      {/* Hero Section */}
      <section className="hero">
        <div className="container">
          <h1 className="hero-title">Be <em>lazy.</em></h1>
          <p className="hero-subtitle">
            Patient capital, rewarded. The vault manages positions so you don't have to.
          </p>
          <div className="hero-cta-group">
            <button className="btn btn-primary" onClick={() => setShowDeposit(true)}>
              Deposit
            </button>
            <Link to="/docs" className="btn btn-secondary">Read the docs</Link>
          </div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="stats-bar">
        <div className="container">
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">
                {tvlValue > 0 ? (
                  <AnimatedNumber value={tvlValue} decimals={2} prefix="$" />
                ) : '...'}
              </div>
              <div className="stat-label">Total Value Locked</div>
            </div>
            <div className="stat-item">
              {apr30dValue !== null ? (
                <div className="stat-apr-comparison">
                  <div className="stat-apr-window">
                    <div className={`stat-value ${aprValue > 0 ? 'positive' : ''}`}>
                      {aprValue > 0 ? (
                        <AnimatedNumber value={aprValue} decimals={1} suffix="%" />
                      ) : '...'}
                    </div>
                    <div className="stat-label">{aprLabel}</div>
                  </div>
                  <div className="stat-apr-divider" />
                  <div className="stat-apr-window">
                    <div className="stat-apr-secondary-value">{apr30dValue.toFixed(1)}%</div>
                    <div className="stat-label">30d APR</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className={`stat-value ${aprValue > 0 ? 'positive' : ''}`}>
                    {aprValue > 0 ? (
                      <AnimatedNumber value={aprValue} decimals={1} suffix="%" />
                    ) : '...'}
                  </div>
                  <div className="stat-label">{aprLabel}</div>
                </>
              )}
            </div>
            <div className="stat-item">
              <div className="stat-value">
                {yieldValue > 0 ? (
                  <AnimatedNumber value={yieldValue} decimals={2} prefix="$" />
                ) : '...'}
              </div>
              <div className="stat-label">Yield earned to date</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">
                <AnimatedNumber value={daysLive} decimals={0} />
              </div>
              <div className="stat-label">Days Live</div>
            </div>
          </div>
        </div>
      </section>

      {/* Vaults Section */}
      <section className="section" id="vaults">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">The <em>vault.</em></h2>
            <p className="section-subtitle">Patient capital starts here.</p>
          </div>

          <div className="vaults-grid">
          {/* lazyUSD Vault */}
          <div className="vault-card">
            <div className="vault-header">
              <div className="vault-icon vault-icon-usdc">$</div>
              <div>
                <h3 className="vault-title">lazyUSD</h3>
                <p className="vault-subtitle">Lazy USDC Vault</p>
              </div>
            </div>

            <div className="vault-stats">
              <div>
                <div className="vault-stat-label">{aprLabel}</div>
                <div className="vault-stat-value positive">{protocolStats?.apr ? `${protocolStats.apr}%` : '...'}</div>
                {apr30dValue !== null && (
                  <div className="vault-stat-submetric">
                    <span>30d</span>
                    <strong>{apr30dValue.toFixed(1)}%</strong>
                  </div>
                )}
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">{tvlDisplay}</div>
              </div>
            </div>

            <div className="vault-notice">
              <Clock size={14} />
              <span>Designed for patient capital · Up to 7-day withdrawal cooldown</span>
            </div>

            <div className="vault-user-section">
              <div className="vault-user-label">Your balance</div>
              <div className="vault-user-balance">
                {isConnected && shareBalance ? formatShares(shareBalance) : '0.00'} lazyUSD
              </div>
              <div className="vault-user-subtext">
                {isConnected && usdcValue ? (
                  <>
                    Worth ${formatUsdc(usdcValue)} USDC
                    {earnings > 0n && (
                      <> · <span className="vault-user-earnings">+${formatUsdc(earnings)}</span></>
                    )}
                  </>
                ) : (
                  'No deposits yet'
                )}
              </div>
              {isConnected && shareBalance && shareBalance > 0n && (
                <button className="vault-cert-trigger" onClick={() => setShowCertificate(true)}>
                  View certificate <ArrowRight size={12} />
                </button>
              )}
            </div>

            <div className="vault-actions">
              <button className="btn btn-primary btn-sm" onClick={() => setShowDeposit(true)}>
                Deposit
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowWithdraw(true)}>
                Withdraw
              </button>
            </div>
          </div>

          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="section" id="how-it-works">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">How it <em>works.</em></h2>
            <p className="section-subtitle">Three steps. Zero maintenance.</p>
          </div>

          <ol className="hiw-register">
            <li className="hiw-row">
              <span className="hiw-roman">i.</span>
              <span className="hiw-head">Deposit.</span>
              <p className="hiw-body">
                Commit your capital. Receive lazyUSD representing your position.
              </p>
            </li>
            <li className="hiw-row">
              <span className="hiw-roman">ii.</span>
              <span className="hiw-head">Wait.</span>
              <p className="hiw-body">
                Your lazyUSD grows in value over time. Patience is the strategy.
              </p>
            </li>
            <li className="hiw-row">
              <span className="hiw-roman">iii.</span>
              <span className="hiw-head">Collect.</span>
              <p className="hiw-body">
                Request a withdrawal. USDC and accrued yield arrive within 7 days.
              </p>
            </li>
          </ol>

          <div className="hiw-foot">
            <Link to="/docs" className="hiw-link">
              Read the full docs <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      {/* Time Machine Calculator */}
      <TimeMachine />

      {/* Transparency line (compressed; full story on /backing) */}
      <section className="section" id="transparency" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">No black <em>boxes.</em></h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            Every position the vault holds is visible on chain. The receipt is published
            on the backing page, refreshed when the operator publishes a snapshot.
          </p>
          <Link to="/backing" className="btn btn-secondary">
            View backing <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      {/* Security Section */}
      <section className="security-section">
        <div className="container">
          <div className="security-content">
          <div className="security-text">
            <h3>Built by paranoid engineers.</h3>
            <p>
              Lazy vaults are secured by formal mathematical proofs. Five invariants
              guarantee your assets are handled fairly, always.
            </p>
          </div>
          <div className="security-badges">
            <div className="security-badge">
              <Shield size={20} />
              5 invariants verified
            </div>
            <div className="security-badge">
              <Eye size={20} />
              Halmos proven
            </div>
            <div className="security-badge">
              <Activity size={20} />
              On-chain NAV
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">Patience <em>pays.</em></h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            Your capital is ready. Patience is the only requirement.
          </p>
          <div className="hero-cta-group" style={{ justifyContent: 'center' }}>
            <button className="btn btn-gold" onClick={() => setShowDeposit(true)}>Deposit</button>
            <Link to="/docs" className="btn btn-secondary">Read the docs</Link>
          </div>
        </div>
      </section>

      {/* Modals */}
      {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} />}
      {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} />}
      {showCertificate && (
        <VaultCertificate
          address={address}
          shareBalance={shareBalance}
          usdcValue={usdcValue}
          onClose={() => setShowCertificate(false)}
        />
      )}
    </>
  );
}
