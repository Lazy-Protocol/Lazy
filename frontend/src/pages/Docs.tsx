import { Link } from 'react-router-dom';
import { Shield, Clock, FileText, ExternalLink, AlertTriangle, ArrowDown, Wallet, Building2, TrendingUp } from 'lucide-react';

export function Docs() {
  return (
    <>
      {/* Hero Section */}
      <section className="hero" style={{ paddingTop: '140px', paddingBottom: '60px' }}>
        <div className="container">
          <h1 className="hero-title">Documentation</h1>
          <p className="hero-subtitle">
            Everything you need to know about Lazy vaults.<br />
            Patient capital, explained.
          </p>
        </div>
      </section>

      {/* Overview */}
      <section className="section" id="overview">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">How Lazy Works</h2>
            <p className="section-subtitle">Three steps. Zero maintenance.</p>
          </div>

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">1</div>
              <h3 className="step-title">Deposit</h3>
              <p className="step-description">
                Deposit USDC and receive lazyUSD tokens representing your share of the vault.
                Your tokens are minted at the current share price.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">2</div>
              <h3 className="step-title">Wait</h3>
              <p className="step-description">
                Your lazyUSD grows in value over time as the vault earns yield.
                No staking, no claiming, no action required. Patience is the strategy.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">3</div>
              <h3 className="step-title">Collect</h3>
              <p className="step-description">
                Request a withdrawal when you're ready. After a short cooldown,
                collect your USDC—plus everything it earned.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Asset Flow */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Where Your USDC Goes</h2>
            <p className="section-subtitle">Follow the money.</p>
          </div>

          <div className="flow-diagram">
            <div className="flow-step">
              <div className="flow-icon">
                <Wallet size={28} />
              </div>
              <div className="flow-content">
                <h4>Your Deposit</h4>
                <p>USDC enters the vault</p>
              </div>
            </div>

            <div className="flow-arrow">
              <ArrowDown size={24} />
            </div>

            <div className="flow-step flow-step-highlight">
              <div className="flow-icon">
                <Shield size={28} />
              </div>
              <div className="flow-content">
                <h4>Vault</h4>
                <p>Keeps a buffer for immediate withdrawals. Excess funds are forwarded to the multisig.</p>
              </div>
            </div>

            <div className="flow-arrow">
              <ArrowDown size={24} />
            </div>

            <div className="flow-step">
              <div className="flow-icon">
                <Building2 size={28} />
              </div>
              <div className="flow-content">
                <h4>Multisig</h4>
                <p>Strategy execution wallet controlled by protocol operators. Deploys capital to yield strategies.</p>
              </div>
            </div>

            <div className="flow-arrow">
              <ArrowDown size={24} />
            </div>

            <div className="flow-step">
              <div className="flow-icon">
                <TrendingUp size={28} />
              </div>
              <div className="flow-content">
                <h4>Yield Strategies</h4>
                <div className="flow-strategies">
                  <span>Basis Trading</span>
                  <span>Funding Rate Farming</span>
                  <span>Pendle PT</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Withdrawal Process */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Withdrawal Process</h2>
            <p className="section-subtitle">How to collect your capital.</p>
          </div>

          <div className="docs-cards">
            <div className="docs-card">
              <div className="docs-card-icon">
                <Clock size={24} />
              </div>
              <h3>Two-Step Withdrawals</h3>
              <p>
                Withdrawals happen in two steps for security. First, you request a withdrawal
                and your lazyUSD is escrowed. After the cooldown period passes, your withdrawal
                is fulfilled and you receive USDC.
              </p>
            </div>

            <div className="docs-card">
              <div className="docs-card-icon">
                <Shield size={24} />
              </div>
              <h3>Your Shares Keep Earning</h3>
              <p>
                While waiting for fulfillment, your escrowed shares continue participating
                in vault gains (and losses). You receive the NAV at fulfillment time,
                not request time.
              </p>
            </div>

            <div className="docs-card">
              <div className="docs-card-icon">
                <FileText size={24} />
              </div>
              <h3>FIFO Queue</h3>
              <p>
                Withdrawals are processed in the order they're received.
                This ensures fair treatment for all depositors—first come, first served.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Model */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Trust Model</h2>
            <p className="section-subtitle">What's on-chain vs. what requires trust.</p>
          </div>

          <div className="trust-warning">
            <AlertTriangle size={20} />
            <div>
              <strong>Semi-Custodial Vault</strong>
              <p>
                Your USDC is deployed to yield strategies via a multisig wallet. If the
                multisig operators do not return funds, withdrawals exceeding the vault's
                buffer cannot be fulfilled. Only deposit what you're comfortable trusting
                to the protocol.
              </p>
            </div>
          </div>

          <div className="trust-grid">
            <div className="trust-card trust-card-safe">
              <h4>Trustless (On-chain)</h4>
              <ul>
                <li>Your share balance and ownership percentage</li>
                <li>Fair NAV calculation for all users</li>
                <li>Withdrawal queue ordering (FIFO)</li>
                <li>Fee caps and collection rules</li>
                <li>Escrow mechanics (no double-spend)</li>
              </ul>
            </div>

            <div className="trust-card trust-card-trust">
              <h4>Requires Trust</h4>
              <ul>
                <li>Multisig returns funds for withdrawals</li>
                <li>Owner reports accurate yield</li>
                <li>Operators process withdrawals regularly</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="security-section">
        <div className="container">
          <div className="security-content">
            <div className="security-text">
              <h3>5 Verified Invariants</h3>
              <p>
                Lazy vaults are secured by formal mathematical proofs—not just audits.
                These invariants guarantee your assets are handled fairly, always.
              </p>
            </div>
            <div className="security-badges">
              <div className="security-badge">
                <Shield size={20} />
                Halmos Proven
              </div>
              <div className="security-badge">
                <Clock size={20} />
                Fuzz Tested
              </div>
              <div className="security-badge">
                <FileText size={20} />
                Audited
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Invariants List */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Security Invariants</h2>
            <p className="section-subtitle">Mathematical guarantees, not promises.</p>
          </div>

          <div className="invariants-list">
            <div className="invariant-item">
              <span className="invariant-id">I.1</span>
              <div>
                <strong>Conservation of Value</strong>
                <p>USDC only exits when shares are burned at current NAV. No exceptions.</p>
              </div>
            </div>

            <div className="invariant-item">
              <span className="invariant-id">I.2</span>
              <div>
                <strong>Share Escrow Safety</strong>
                <p>Escrowed shares are locked and cannot be double-spent or transferred.</p>
              </div>
            </div>

            <div className="invariant-item">
              <span className="invariant-id">I.3</span>
              <div>
                <strong>Universal NAV Application</strong>
                <p>Share price applies uniformly to all shares—no special treatment.</p>
              </div>
            </div>

            <div className="invariant-item">
              <span className="invariant-id">I.4</span>
              <div>
                <strong>Fee Isolation</strong>
                <p>Fees only on positive yield, only via share minting. Never from principal.</p>
              </div>
            </div>

            <div className="invariant-item">
              <span className="invariant-id">I.5</span>
              <div>
                <strong>Withdrawal Queue Liveness</strong>
                <p>FIFO ordering with graceful degradation. Queue never reverts.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Resources */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Resources</h2>
            <p className="section-subtitle">Explore the code.</p>
          </div>

          <div className="resources-grid">
            <a
              href="https://github.com/lazy-protocol"
              target="_blank"
              rel="noopener noreferrer"
              className="resource-link"
            >
              <span>GitHub Repository</span>
              <ExternalLink size={18} />
            </a>

            <a
              href="https://etherscan.io"
              target="_blank"
              rel="noopener noreferrer"
              className="resource-link"
            >
              <span>Contract on Etherscan</span>
              <ExternalLink size={18} />
            </a>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">Ready to start?</h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            Patient capital, rewarded.
          </p>
          <Link to="/#vaults" className="btn btn-gold">View Vaults</Link>
        </div>
      </section>
    </>
  );
}
