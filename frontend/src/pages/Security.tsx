import { Shield, Lock, Eye, FileCheck, ExternalLink, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

const INVARIANTS = [
  {
    name: 'Deposit Invariant',
    description: 'You always receive shares proportional to your deposit relative to the vault\'s total assets.',
  },
  {
    name: 'Withdrawal Invariant',
    description: 'You always receive assets proportional to the shares you redeem.',
  },
  {
    name: 'Solvency Invariant',
    description: 'The vault always has enough assets to cover all outstanding shares at the current share price.',
  },
  {
    name: 'Share Price Invariant',
    description: 'The share price only changes due to yield accrual or loss events, never from deposits or withdrawals.',
  },
  {
    name: 'Fairness Invariant',
    description: 'Withdrawals are processed in the order they were requested. No queue jumping.',
  },
];

const SECURITY_FEATURES = [
  {
    icon: Shield,
    title: 'Formal Verification',
    description: 'Core vault logic verified with Halmos symbolic execution. Mathematical proofs, not just tests.',
  },
  {
    icon: Lock,
    title: 'Audited Contracts',
    description: 'Independent security review of all smart contracts before mainnet deployment.',
  },
  {
    icon: Eye,
    title: 'On-chain Transparency',
    description: 'All positions, trades, and NAV calculations happen on-chain. Fully verifiable.',
  },
  {
    icon: FileCheck,
    title: 'Withdrawal Queue',
    description: 'Orderly withdrawals prevent bank runs and ensure fair treatment for all depositors.',
  },
];

export function Security() {
  return (
    <div className="security-page">
      {/* Hero */}
      <section className="section" style={{ paddingTop: 'var(--space-3xl)' }}>
        <div className="container-narrow" style={{ textAlign: 'center' }}>
          <div style={{
            width: 64,
            height: 64,
            background: 'var(--yield-gold)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-lg)'
          }}>
            <Shield size={32} color="var(--lazy-navy)" />
          </div>
          <h1 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
            Security First
          </h1>
          <p className="section-subtitle" style={{ maxWidth: 600, margin: '0 auto' }}>
            Your capital is protected by mathematical proofs, not promises.
            We built Lazy with the same rigor we'd want for our own funds.
          </p>
        </div>
      </section>

      {/* Security Features */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="steps-grid">
            {SECURITY_FEATURES.map((feature) => (
              <div key={feature.title} className="step-card">
                <div className="step-number">
                  <feature.icon size={24} />
                </div>
                <h3 className="step-title">{feature.title}</h3>
                <p className="step-description">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Invariants */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Five Invariants</h2>
            <p className="section-subtitle">
              Properties that always hold true, verified by formal mathematical proofs.
            </p>
          </div>

          <div style={{
            display: 'grid',
            gap: 'var(--space-md)',
            maxWidth: 800,
            margin: '0 auto'
          }}>
            {INVARIANTS.map((inv, i) => (
              <div
                key={inv.name}
                style={{
                  background: 'white',
                  borderRadius: 'var(--radius-lg)',
                  padding: 'var(--space-lg)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-md)',
                }}
              >
                <div style={{
                  width: 32,
                  height: 32,
                  background: 'var(--success-muted)',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <CheckCircle size={18} color="var(--success)" />
                </div>
                <div>
                  <h4 style={{
                    fontWeight: 600,
                    color: 'var(--ink)',
                    marginBottom: 'var(--space-xs)'
                  }}>
                    {i + 1}. {inv.name}
                  </h4>
                  <p style={{ color: 'var(--slate)', fontSize: '0.9375rem', lineHeight: 1.6 }}>
                    {inv.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Halmos Section */}
      <section className="section" style={{ background: 'var(--lazy-navy)' }}>
        <div className="container-narrow" style={{ textAlign: 'center' }}>
          <h2 style={{
            color: 'var(--drift-white)',
            fontSize: '1.75rem',
            fontWeight: 600,
            marginBottom: 'var(--space-md)'
          }}>
            Verified with Halmos
          </h2>
          <p style={{
            color: 'var(--slate)',
            maxWidth: 600,
            margin: '0 auto var(--space-lg)',
            lineHeight: 1.6
          }}>
            Halmos is a symbolic execution tool that proves properties hold for all possible inputs.
            Unlike traditional testing that checks specific cases, formal verification proves correctness mathematically.
          </p>
          <a
            href="https://github.com/a]16z/halmos"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
            style={{ gap: 'var(--space-sm)' }}
          >
            Learn about Halmos <ExternalLink size={16} />
          </a>
        </div>
      </section>

      {/* Audit Section */}
      <section className="section">
        <div className="container-narrow" style={{ textAlign: 'center' }}>
          <h2 className="section-title">Independent Audit</h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            All smart contracts undergo rigorous third-party security review before deployment.
          </p>
          <div style={{
            background: 'white',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-xl)',
            border: '1px solid var(--cloud)',
          }}>
            <p style={{ color: 'var(--slate)', marginBottom: 'var(--space-md)' }}>
              Audit report will be published here upon completion.
            </p>
            <p style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
              color: 'var(--ink)'
            }}>
              Status: In progress
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">Questions?</h2>
          <p className="section-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
            Review the technical documentation or reach out to the team.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'center' }}>
            <Link to="/docs" className="btn btn-primary">
              Read the Docs
            </Link>
            <Link to="/backing" className="btn btn-secondary">
              View Backing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
