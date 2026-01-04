import { ExternalLink, Shield, Zap, Clock, AlertTriangle } from 'lucide-react';

export function Docs() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold text-drift-white mb-8">Documentation</h1>

      {/* Overview */}
      <section className="mb-12">
        <h2 className="text-xl font-semibold text-drift-white mb-4">Overview</h2>
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <p className="text-drift-white/70 mb-4">
            The USDC Savings Vault allows you to earn yield on your USDC holdings. When you
            deposit USDC, you receive vault shares that represent your proportional ownership.
            As the vault generates yield, your shares become worth more USDC.
          </p>
          <p className="text-drift-white/70">
            The vault deploys capital to yield-generating strategies including basis trading,
            funding rate farming, and Pendle PT positions.
          </p>
        </div>
      </section>

      {/* How It Works */}
      <section className="mb-12">
        <h2 className="text-xl font-semibold text-drift-white mb-4">How It Works</h2>
        <div className="space-y-4">
          <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-yield-gold/10 rounded-lg flex items-center justify-center">
                <Zap className="w-4 h-4 text-yield-gold" />
              </div>
              <h3 className="text-lg font-medium text-drift-white">Depositing</h3>
            </div>
            <p className="text-drift-white/70">
              When you deposit USDC, you receive vault shares proportional to the current
              share price. The vault keeps a buffer for immediate withdrawals and deploys
              excess funds to yield strategies via the multisig.
            </p>
          </div>

          <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-yield-gold/10 rounded-lg flex items-center justify-center">
                <Clock className="w-4 h-4 text-yield-gold" />
              </div>
              <h3 className="text-lg font-medium text-drift-white">Withdrawing</h3>
            </div>
            <p className="text-drift-white/70 mb-4">
              Withdrawals are a 2-step process:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-drift-white/70">
              <li>Request withdrawal - your shares are escrowed in the vault</li>
              <li>After the cooldown period (~7 days), an operator fulfills your request</li>
            </ol>
            <p className="text-drift-white/50 text-sm mt-4">
              Your escrowed shares continue to earn yield until fulfilled.
            </p>
          </div>

          <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-yield-gold/10 rounded-lg flex items-center justify-center">
                <Shield className="w-4 h-4 text-yield-gold" />
              </div>
              <h3 className="text-lg font-medium text-drift-white">Share Price</h3>
            </div>
            <p className="text-drift-white/70">
              The share price is calculated as: <code className="bg-lazy-navy px-2 py-1 rounded text-yield-gold">totalAssets / totalShares</code>.
              When yield is earned, the share price increases. All shareholders benefit
              proportionally to their ownership.
            </p>
          </div>
        </div>
      </section>

      {/* Trust Model */}
      <section className="mb-12">
        <h2 className="text-xl font-semibold text-drift-white mb-4">Trust Model</h2>
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-2xl p-6 mb-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-yellow-500 font-medium mb-2">Semi-Custodial Vault</p>
              <p className="text-drift-white/70 text-sm">
                Your USDC is deployed to yield strategies via a multisig wallet. If the
                multisig operators do not return funds, withdrawals exceeding the vault's
                buffer cannot be fulfilled.
              </p>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-lazy-navy-light/50 rounded-xl p-5 border border-lazy-navy-light">
            <h4 className="text-success font-medium mb-3">Trustless (On-chain)</h4>
            <ul className="space-y-2 text-drift-white/70 text-sm">
              <li>• Your share balance and ownership %</li>
              <li>• Fair NAV calculation for all users</li>
              <li>• Withdrawal queue ordering (FIFO)</li>
              <li>• Fee caps and collection rules</li>
            </ul>
          </div>
          <div className="bg-lazy-navy-light/50 rounded-xl p-5 border border-lazy-navy-light">
            <h4 className="text-warning font-medium mb-3">Requires Trust</h4>
            <ul className="space-y-2 text-drift-white/70 text-sm">
              <li>• Multisig returns funds for withdrawals</li>
              <li>• Owner reports accurate yield</li>
              <li>• Operators process withdrawals regularly</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="mb-12">
        <h2 className="text-xl font-semibold text-drift-white mb-4">Security</h2>
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <h3 className="text-lg font-medium text-drift-white mb-4">5 Verified Invariants</h3>
          <ul className="space-y-3">
            <li className="flex items-start gap-3">
              <span className="text-yield-gold font-mono text-sm">I.1</span>
              <span className="text-drift-white/70">Conservation of Value — USDC only exits when shares are burned at current NAV</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-yield-gold font-mono text-sm">I.2</span>
              <span className="text-drift-white/70">Share Escrow Safety — Escrowed shares always equal pending withdrawal shares</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-yield-gold font-mono text-sm">I.3</span>
              <span className="text-drift-white/70">Universal NAV Application — Share price applies uniformly to all share classes</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-yield-gold font-mono text-sm">I.4</span>
              <span className="text-drift-white/70">Fee Isolation — Fees only on profit, only via share minting</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-yield-gold font-mono text-sm">I.5</span>
              <span className="text-drift-white/70">Withdrawal Queue Liveness — FIFO order, graceful termination</span>
            </li>
          </ul>
        </div>
      </section>

      {/* Links */}
      <section>
        <h2 className="text-xl font-semibold text-drift-white mb-4">Resources</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <a
            href="https://github.com/lazy-protocol"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-lazy-navy-light/50 rounded-xl p-5 border border-lazy-navy-light hover:border-yield-gold/30 transition-colors flex items-center justify-between"
          >
            <span className="text-drift-white font-medium">GitHub Repository</span>
            <ExternalLink className="w-4 h-4 text-drift-white/50" />
          </a>
          <a
            href="https://etherscan.io"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-lazy-navy-light/50 rounded-xl p-5 border border-lazy-navy-light hover:border-yield-gold/30 transition-colors flex items-center justify-between"
          >
            <span className="text-drift-white font-medium">Contract on Etherscan</span>
            <ExternalLink className="w-4 h-4 text-drift-white/50" />
          </a>
        </div>
      </section>
    </div>
  );
}
