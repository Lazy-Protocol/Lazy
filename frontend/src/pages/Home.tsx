import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useVaultStats, useUserData, formatUsdc, formatShares } from '@/hooks/useVault';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { DepositModal } from '@/components/DepositModal';
import { WithdrawModal } from '@/components/WithdrawModal';
import { Link } from 'react-router-dom';
import { Shield, Clock, FileText, Info, Eye, Activity, ArrowRight } from 'lucide-react';

// Vault launch date (January 7, 2026)
const LAUNCH_DATE = new Date('2026-01-07T00:00:00Z');

function getDaysLive(): number {
  const now = new Date();
  const diffMs = now.getTime() - LAUNCH_DATE.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function Home() {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const { address, isConnected } = useAccount();
  const { totalAssets, accumulatedYield, isLoading } = useVaultStats();
  const { shareBalance, usdcValue, totalDeposited } = useUserData(address);
  const { data: protocolStats } = useProtocolStats();

  // Format yield for display (only show positive yield as "distributed")
  const yieldDistributed = accumulatedYield !== undefined && accumulatedYield > 0n
    ? formatUsdc(accumulatedYield)
    : '0.00';
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
          <h1 className="hero-title">Be lazy.</h1>
          <p className="hero-subtitle">
            Patient capital, rewarded.<br />
            No staking. No claiming. Just yield.
          </p>
          <div className="hero-cta-group">
            <a href="#vaults" className="btn btn-primary">View Vaults</a>
            <a href="#how-it-works" className="btn btn-secondary">How it works</a>
          </div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="stats-bar">
        <div className="container">
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">{isLoading ? '...' : `$${totalAssets ? formatUsdc(totalAssets) : '0.00'}`}</div>
              <div className="stat-label">Total Value Locked</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{protocolStats?.apr ? `${protocolStats.apr}%` : '...'}</div>
              <div className="stat-label">{protocolStats?.aprPeriod === '7d' ? '7d APR' : 'APR'}</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{isLoading ? '...' : `$${yieldDistributed}`}</div>
              <div className="stat-label">Yield Distributed</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{getDaysLive()}</div>
              <div className="stat-label">Days Live</div>
            </div>
          </div>
        </div>
      </section>

      {/* Vaults Section */}
      <section className="section" id="vaults">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Vaults</h2>
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
                <div className="vault-stat-label">{protocolStats?.aprPeriod === '7d' ? '7d APR' : 'APR'}</div>
                <div className="vault-stat-value positive">{protocolStats?.apr ? `${protocolStats.apr}%` : '...'}</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">{isLoading ? '...' : `$${totalAssets ? formatUsdc(totalAssets) : '0.00'}`}</div>
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

          {/* lazyETH Vault (Coming Soon) */}
          <div className="vault-card" style={{ opacity: 0.6 }}>
            <div className="vault-header">
              <div className="vault-icon vault-icon-eth">Ξ</div>
              <div>
                <h3 className="vault-title">lazyETH</h3>
                <p className="vault-subtitle">ETH Savings Vault</p>
              </div>
            </div>

            <div className="vault-stats">
              <div>
                <div className="vault-stat-label">APY</div>
                <div className="vault-stat-value">...</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">...</div>
              </div>
            </div>

            <div className="vault-user-section">
              <div className="vault-user-label">Status</div>
              <div className="vault-user-balance" style={{ fontFamily: 'var(--font-primary)', fontSize: '1rem' }}>
                Coming soon
              </div>
              <div className="vault-user-subtext">Launching Q2 2026</div>
            </div>

            <div className="vault-actions">
              <button className="btn btn-secondary btn-sm" style={{ gridColumn: 'span 2' }} disabled>
                Notify me
              </button>
            </div>
          </div>

          {/* lazyHYPE Vault (Coming Soon) */}
          <div className="vault-card" style={{ opacity: 0.6 }}>
            <div className="vault-header">
              <div className="vault-icon vault-icon-hype">H</div>
              <div>
                <h3 className="vault-title">lazyHYPE</h3>
                <p className="vault-subtitle">HYPE Savings Vault</p>
              </div>
            </div>

            <div className="vault-stats">
              <div>
                <div className="vault-stat-label">APY</div>
                <div className="vault-stat-value">...</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">...</div>
              </div>
            </div>

            <div className="vault-user-section">
              <div className="vault-user-label">Status</div>
              <div className="vault-user-balance" style={{ fontFamily: 'var(--font-primary)', fontSize: '1rem' }}>
                Coming soon
              </div>
              <div className="vault-user-subtext">Launching Q2 2026</div>
            </div>

            <div className="vault-actions">
              <button className="btn btn-secondary btn-sm" style={{ gridColumn: 'span 2' }} disabled>
                Notify me
              </button>
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="section" id="how-it-works" style={{ background: 'white' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">How it works</h2>
            <p className="section-subtitle">Three steps. Zero maintenance.</p>
          </div>

          <div className="steps-grid">
          <div className="step-card">
            <div className="step-number">1</div>
            <h3 className="step-title">Deposit</h3>
            <p className="step-description">
              Commit your capital. Receive lazyUSD representing your share.
            </p>
          </div>

          <div className="step-card">
            <div className="step-number">2</div>
            <h3 className="step-title">Wait</h3>
            <p className="step-description">
              Your lazyUSD grows in value over time. Patience is the strategy.
            </p>
          </div>

          <div className="step-card">
            <div className="step-number">3</div>
            <h3 className="step-title">Collect</h3>
            <p className="step-description">
              When you're ready, claim your capital, plus everything it earned.
            </p>
          </div>
          </div>
        </div>
      </section>

      {/* Transparency Section */}
      <section className="section" id="transparency">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">No black boxes.</h2>
            <p className="section-subtitle">Trust, but verify.</p>
          </div>

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">
                <Info size={24} />
              </div>
              <h3 className="step-title">Onchain NAV</h3>
              <p className="step-description">
                Net Asset Value computed transparently onchain. No offchain oracles, no trust assumptions.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">
                <Eye size={24} />
              </div>
              <h3 className="step-title">Visible positions</h3>
              <p className="step-description">
                Every asset, every position. Fully verifiable. See exactly where your capital is working.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">
                <Activity size={24} />
              </div>
              <h3 className="step-title">Onchain execution</h3>
              <p className="step-description">
                Positions held on Hyperliquid and Lighter. All trades, all movements. Public and auditable.
              </p>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginTop: 'var(--space-xl)' }}>
            <Link to="/backing" className="btn btn-secondary">
              View Backing Details <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* Security Section */}
      <section className="security-section">
        <div className="container">
          <div className="security-content">
          <div className="security-text">
            <h3>Built by paranoid engineers.</h3>
            <p>
              Lazy vaults are secured by formal mathematical proofs, not just audits.
              Five invariants guarantee your assets are handled fairly, always.
            </p>
          </div>
          <div className="security-badges">
            <div className="security-badge">
              <Shield size={20} />
              5 Invariants Verified
            </div>
            <div className="security-badge">
              <Clock size={20} />
              Halmos Proven
            </div>
            <div className="security-badge">
              <FileText size={20} />
              Audited
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">Patience pays.</h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            Your capital is ready to work. Are you ready to wait?
          </p>
          <a href="#vaults" className="btn btn-gold">Start Earning</a>
        </div>
      </section>

      {/* Modals */}
      {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} />}
      {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} />}
    </>
  );
}
