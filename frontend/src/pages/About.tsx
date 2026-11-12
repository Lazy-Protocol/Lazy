import { Shield, Clock, Eye, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

export function About() {
  return (
    <>
      {/* Hero Section */}
      <section className="section hero-section">
        <div className="container">
          <h1 className="hero-title">We built Lazy because DeFi is exhausting.</h1>
          <p className="hero-subtitle">
            Claiming rewards. Rotating strategies. Watching gas prices.<br />
            Waking up at 3am because something moved.
          </p>
        </div>
      </section>

      {/* Story Section */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">We wanted yield that rewards patience, not attention.</h2>
            <p className="section-subtitle">So we built it.</p>
          </div>

          <div className="steps-grid" style={{ marginTop: 'var(--space-2xl)' }}>
            <div className="step-card">
              <div className="step-number">
                <Shield size={24} />
              </div>
              <h3 className="step-title">Formal verification</h3>
              <p className="step-description">
                Mathematical proofs that guarantee fair asset handling. Five invariants. Zero exceptions.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">
                <Zap size={24} />
              </div>
              <h3 className="step-title">Automatic accounting</h3>
              <p className="step-description">
                Yield accrues directly to your shares. No claiming. No compounding. It just happens.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">
                <Clock size={24} />
              </div>
              <h3 className="step-title">Withdrawals that work</h3>
              <p className="step-description">
                Request today, receive after cooldown. No stuck funds. No emergency votes. Predictable.
              </p>
            </div>

            <div className="step-card">
              <div className="step-number">
                <Eye size={24} />
              </div>
              <h3 className="step-title">Fees only on profits</h3>
              <p className="step-description">
                We earn when you earn. Aligned incentives. No management fees eating your principal.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Values Section */}
      <section className="section" style={{ background: 'var(--drift-white)' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Patient capital, rewarded.</h2>
            <p className="section-subtitle">That's Lazy.</p>
          </div>

          <div style={{ maxWidth: '640px', margin: '0 auto', textAlign: 'center' }}>
            <p style={{ fontSize: '1.125rem', lineHeight: 1.7, color: 'var(--slate)', marginBottom: 'var(--space-lg)' }}>
              We believe the best returns come from holding, not trading. From trusting the math, not the hype.
              From building infrastructure that lets you sleep at night.
            </p>
            <p style={{ fontSize: '1.125rem', lineHeight: 1.7, color: 'var(--slate)', marginBottom: 'var(--space-xl)' }}>
              Lazy isn't for everyone. It's for the patient ones. The ones who know that time in the market
              beats timing the market. The ones ready to wait.
            </p>

            <Link to="/#vaults" className="btn btn-gold">
              Start Earning
            </Link>
          </div>
        </div>
      </section>

      {/* Technical Section */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Lazy surface. Paranoid core.</h2>
            <p className="section-subtitle">Built by engineers who've seen what can go wrong.</p>
          </div>

          <div className="docs-cards" style={{ marginTop: 'var(--space-2xl)' }}>
            <div className="docs-card">
              <h3>Delta-neutral strategies</h3>
              <p>
                Long spot, short perps. Market-neutral positioning that generates yield regardless of price direction.
              </p>
            </div>

            <div className="docs-card">
              <h3>Multi-venue execution</h3>
              <p>
                Positions across Hyperliquid, Lighter, and Pendle. Diversified counterparty risk.
                All verifiable on-chain.
              </p>
            </div>

            <div className="docs-card">
              <h3>Transparent NAV</h3>
              <p>
                Net Asset Value computed on-chain from real positions. No oracles. No trust assumptions.
                Just math.
              </p>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginTop: 'var(--space-2xl)' }}>
            <Link to="/docs" className="btn btn-primary">
              Read the Docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
