import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useVaultStats, useUserData, formatUsdc, formatShares } from '@/hooks/useVault';
import { DepositModal } from '@/components/DepositModal';
import { WithdrawModal } from '@/components/WithdrawModal';
import { Shield, Clock, FileText } from 'lucide-react';

export function Home() {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const { address, isConnected } = useAccount();
  const { totalAssets } = useVaultStats();
  const { shareBalance, usdcValue, totalDeposited } = useUserData(address);

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
            Deposit your crypto. Earn yield automatically.<br />
            No staking. No claiming. No thinking.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
            <a href="#vaults" className="btn btn-primary">View Vaults</a>
            <a href="#how-it-works" className="btn btn-secondary">How it works</a>
          </div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="stats-bar">
        <div className="stats-grid">
          <div style={{ textAlign: 'center' }}>
            <div className="stat-value">${totalAssets ? formatUsdc(totalAssets) : '—'}</div>
            <div className="stat-label">Total Value Locked</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className="stat-value">5.2%</div>
            <div className="stat-label">Average APY</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className="stat-value">2,847</div>
            <div className="stat-label">Active Depositors</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className="stat-value">$847K</div>
            <div className="stat-label">Yield Distributed</div>
          </div>
        </div>
      </section>

      {/* Vaults Section */}
      <section className="section" id="vaults">
        <div className="section-header">
          <h2 className="section-title">Vaults</h2>
          <p className="section-subtitle">Pick an asset. Deposit. That's it.</p>
        </div>

        <div className="vaults-grid">
          {/* lazyUSD Vault */}
          <div className="vault-card">
            <div className="vault-header">
              <div className="vault-icon vault-icon-usdc">$</div>
              <div>
                <h3 className="vault-title">lazyUSD</h3>
                <p className="vault-subtitle">USDC Savings Vault</p>
              </div>
            </div>

            <div className="vault-stats">
              <div>
                <div className="vault-stat-label">APY</div>
                <div className="vault-stat-value positive">5.2%</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">${totalAssets ? formatUsdc(totalAssets) : '—'}</div>
              </div>
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

          {/* lazyETH Vault */}
          <div className="vault-card">
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
                <div className="vault-stat-value positive">4.1%</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">$6.8M</div>
              </div>
            </div>

            <div className="vault-user-section">
              <div className="vault-user-label">Your balance</div>
              <div className="vault-user-balance">0.00 lazyETH</div>
              <div className="vault-user-subtext">No deposits yet</div>
            </div>

            <div className="vault-actions">
              <button className="btn btn-primary btn-sm" disabled>Deposit</button>
              <button className="btn btn-secondary btn-sm" disabled>Withdraw</button>
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
                <div className="vault-stat-value">—</div>
              </div>
              <div>
                <div className="vault-stat-label">TVL</div>
                <div className="vault-stat-value">—</div>
              </div>
            </div>

            <div className="vault-user-section">
              <div className="vault-user-label">Status</div>
              <div className="vault-user-balance" style={{ fontFamily: 'var(--font-primary)', fontSize: '1rem' }}>
                Coming soon
              </div>
              <div className="vault-user-subtext">Launching Q1 2025</div>
            </div>

            <div className="vault-actions">
              <button className="btn btn-secondary btn-sm" style={{ gridColumn: 'span 2' }} disabled>
                Notify me
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="section" id="how-it-works" style={{ background: 'white' }}>
        <div className="section-header">
          <h2 className="section-title">How it works</h2>
          <p className="section-subtitle">Three steps. Zero maintenance.</p>
        </div>

        <div className="steps-grid">
          <div className="step-card">
            <div className="step-number">1</div>
            <h3 className="step-title">Deposit</h3>
            <p className="step-description">
              Connect your wallet and deposit any supported asset. You'll receive lazy tokens representing your share.
            </p>
          </div>

          <div className="step-card">
            <div className="step-number">2</div>
            <h3 className="step-title">Earn</h3>
            <p className="step-description">
              Your lazy tokens automatically grow in value as yield accrues. No claiming, no staking, no manual actions.
            </p>
          </div>

          <div className="step-card">
            <div className="step-number">3</div>
            <h3 className="step-title">Withdraw</h3>
            <p className="step-description">
              Request a withdrawal anytime. After a short cooldown, your assets are returned—plus all earned yield.
            </p>
          </div>
        </div>
      </section>

      {/* Security Section */}
      <section className="security-section">
        <div className="security-content">
          <div className="security-text">
            <h3>Built by paranoid engineers.</h3>
            <p>
              Lazy vaults are secured by formal mathematical proofs—not just audits.
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
      </section>

      {/* CTA Section */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '0 24px' }}>
          <h2 className="section-title">Ready to be lazy?</h2>
          <p className="section-subtitle" style={{ marginBottom: '32px' }}>
            Your yield is waiting. You don't have to.
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
