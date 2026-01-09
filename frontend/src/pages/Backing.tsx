import { ExternalLink, Copy, Check, Shield, Activity } from 'lucide-react';
import { LiveBackingData } from '@/components/BackingData';
import { useState } from 'react';

// Treasury multisig - holds all positions
const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';

// Operator wallet - for apps without Safe support
const OPERATOR_ADDRESS = '0xF466ad87c98f50473Cf4Fe32CdF8db652F9E36D6';

// Explorer links
const EXPLORERS = {
  multisig: {
    etherscan: `https://etherscan.io/address/${MULTISIG_ADDRESS}`,
    hyperevm: `https://hyperevmscan.io/address/${MULTISIG_ADDRESS}`,
    lighter: `https://app.lighter.xyz/explorer/accounts/${MULTISIG_ADDRESS}`,
    pendle: `https://app.pendle.finance/trade/portfolio/${MULTISIG_ADDRESS}`,
  },
  operator: {
    hypurrscan: `https://hypurrscan.io/address/${OPERATOR_ADDRESS}`,
    hyperevm: `https://hyperevmscan.io/address/${OPERATOR_ADDRESS}`,
  },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className="copy-btn" title="Copy address">
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function Backing() {
  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="container">
          <h1 className="hero-title">No black boxes.</h1>
          <p className="hero-subtitle">
            Patient capital doesn't hide. Neither do we.<br />
            Everything backing your lazyUSD — visible, verifiable, onchain.
          </p>
        </div>
      </section>

      {/* Wallets Section */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Where your capital lives.</h2>
            <p className="section-subtitle">Two wallets. Full visibility. No mystery.</p>
          </div>

          <div className="wallets-grid">
            {/* Treasury Multisig */}
            <div className="wallet-card">
              <div className="wallet-card-badge">Primary</div>
              <div className="wallet-card-header">
                <Shield size={24} />
                <h3>Treasury Multisig</h3>
              </div>
              <p className="wallet-card-desc">
                Holds all protocol positions. Every asset verifiable onchain.
              </p>
              <div className="wallet-card-address">
                <code>{MULTISIG_ADDRESS}</code>
                <CopyButton text={MULTISIG_ADDRESS} />
              </div>
              <div className="wallet-card-links">
                <a href={EXPLORERS.multisig.etherscan} target="_blank" rel="noopener noreferrer">
                  Etherscan <ExternalLink size={12} />
                </a>
                <a href={EXPLORERS.multisig.hyperevm} target="_blank" rel="noopener noreferrer">
                  HyperEVM <ExternalLink size={12} />
                </a>
                <a href={EXPLORERS.multisig.lighter} target="_blank" rel="noopener noreferrer">
                  Lighter <ExternalLink size={12} />
                </a>
                <a href={EXPLORERS.multisig.pendle} target="_blank" rel="noopener noreferrer">
                  Pendle <ExternalLink size={12} />
                </a>
              </div>
            </div>

            {/* Operator Wallet */}
            <div className="wallet-card">
              <div className="wallet-card-badge">Operator</div>
              <div className="wallet-card-header">
                <Activity size={24} />
                <h3>Operator Wallet</h3>
              </div>
              <p className="wallet-card-desc">
                Executes on venues without Safe support. Same transparency.
              </p>
              <div className="wallet-card-address">
                <code>{OPERATOR_ADDRESS}</code>
                <CopyButton text={OPERATOR_ADDRESS} />
              </div>
              <div className="wallet-card-links">
                <a href={EXPLORERS.operator.hypurrscan} target="_blank" rel="noopener noreferrer">
                  Hypurrscan <ExternalLink size={12} />
                </a>
                <a href={EXPLORERS.operator.hyperevm} target="_blank" rel="noopener noreferrer">
                  HyperEVM <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live Data */}
      <LiveBackingData />

      {/* Capital Allocation */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">How your capital works.</h2>
            <p className="section-subtitle">You deposit. We allocate. The yield finds you.</p>
          </div>

          <div className="allocation-grid">
            <div className="allocation-card">
              <div className="allocation-percent">30%</div>
              <h4>Perp Collateral</h4>
              <p>Short positions on Hyperliquid & Lighter for delta hedging</p>
            </div>

            <div className="allocation-card">
              <div className="allocation-percent">70%</div>
              <h4>Spot Holdings</h4>
              <p>Long spot to neutralize delta exposure</p>
            </div>

            <div className="allocation-card allocation-card-highlight">
              <div className="allocation-percent">=</div>
              <h4>Delta Neutral</h4>
              <p>No directional market exposure</p>
            </div>
          </div>

          <div className="yield-layer-card">
            <h4>Then the spot earns.</h4>
            <p>The 70% spot holdings are deployed into yield-bearing positions:</p>
            <div className="yield-assets">
              <span>stHYPE</span>
              <span>stETH</span>
              <span>jitoSOL</span>
              <span>Pendle PT</span>
            </div>
          </div>

          <p className="allocation-note">
            Two yield streams: funding rates from perps + staking/PT yields from spot.<br />
            The mix shifts based on rates. The transparency doesn't.
          </p>
        </div>
      </section>

      {/* Yield Sources */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Where yield comes from.</h2>
            <p className="section-subtitle">Two streams. One lazy token.</p>
          </div>

          <div className="yield-sources-grid">
            <div className="yield-source-card">
              <h4>Funding Rates</h4>
              <p>
                Delta-neutral perp positions earn funding when shorts get paid.
                Hyperliquid & Lighter.
              </p>
              <span className="yield-source-tag">From the 30%</span>
            </div>
            <div className="yield-source-card">
              <h4>Staking & PT Yields</h4>
              <p>
                Spot holdings earn staking rewards (stHYPE, stETH, jitoSOL)
                or fixed PT yields via Pendle.
              </p>
              <span className="yield-source-tag">From the 70%</span>
            </div>
          </div>

          <p className="yield-note">
            Rates fluctuate. That's DeFi. Current vault APY is always shown on the{' '}
            <a href="/">deposit page</a>.
          </p>
        </div>
      </section>

      {/* Trust but Verify */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Trust, but verify.</h2>
          </div>

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">1</div>
              <h3 className="step-title">Check the wallets</h3>
              <p className="step-description">Every address is public. Click through to any explorer.</p>
            </div>
            <div className="step-card">
              <div className="step-number">2</div>
              <h3 className="step-title">See the positions</h3>
              <p className="step-description">Hyperliquid, Lighter, Pendle — all onchain, all visible.</p>
            </div>
            <div className="step-card">
              <div className="step-number">3</div>
              <h3 className="step-title">Verify the NAV</h3>
              <p className="step-description">Net Asset Value computed onchain. No oracles. No trust assumptions.</p>
            </div>
          </div>

          <p className="verify-cta">Don't trust us. Check the chain.</p>
        </div>
      </section>

      {/* CTA */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 className="section-title">See for yourself.</h2>
          <div className="cta-links">
            <a
              href={EXPLORERS.multisig.lighter}
              className="btn btn-primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Lighter <ExternalLink size={16} />
            </a>
            <a
              href={EXPLORERS.operator.hypurrscan}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Hypurrscan <ExternalLink size={16} />
            </a>
            <a
              href={EXPLORERS.multisig.etherscan}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Etherscan <ExternalLink size={16} />
            </a>
          </div>
          <p className="cta-tagline">Patient capital deserves proof, not promises.</p>
        </div>
      </section>
    </>
  );
}

export default Backing;
