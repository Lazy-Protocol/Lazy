import { VaultCard } from '@/components/VaultCard';
import { Shield, Zap, Clock, CheckCircle } from 'lucide-react';

const features = [
  {
    icon: Zap,
    title: 'Automated Yield',
    description: 'Deposit once, earn yield automatically through diversified strategies.',
  },
  {
    icon: Shield,
    title: '5 Invariants Verified',
    description: 'Formally verified smart contracts with comprehensive security tests.',
  },
  {
    icon: Clock,
    title: '24/7 Operations',
    description: 'Continuous yield generation with transparent on-chain accounting.',
  },
  {
    icon: CheckCircle,
    title: 'Fair NAV Pricing',
    description: 'All users share gains and losses equally based on share ownership.',
  },
];

export function Home() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Hero */}
      <div className="text-center mb-16">
        <h1 className="text-4xl md:text-5xl font-bold text-drift-white mb-4">
          Earn Yield While You Sleep
        </h1>
        <p className="text-xl text-drift-white/70 max-w-2xl mx-auto">
          Deposit your assets. We handle the strategies. You collect the yield.
        </p>
      </div>

      {/* Vault Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
        <VaultCard
          name="lazyUSD"
          symbol="svUSDC"
          description="Earn yield on USDC through basis trading, funding rates, and Pendle PT strategies."
          apy="8-15%"
        />
        <VaultCard
          name="lazyETH"
          symbol="svETH"
          description="Maximize ETH yields through liquid staking and DeFi strategies."
          apy="5-10%"
          comingSoon
        />
        <VaultCard
          name="lazyHYPE"
          symbol="svHYPE"
          description="High-yield opportunities for risk-tolerant investors."
          apy="15-30%"
          comingSoon
        />
      </div>

      {/* How It Works */}
      <div className="mb-16">
        <h2 className="text-2xl font-bold text-drift-white text-center mb-8">
          How It Works
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-12 h-12 bg-yield-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-yield-gold font-bold text-xl">1</span>
            </div>
            <h3 className="text-lg font-semibold text-drift-white mb-2">Deposit</h3>
            <p className="text-drift-white/70">
              Connect your wallet and deposit USDC into the vault.
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-yield-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-yield-gold font-bold text-xl">2</span>
            </div>
            <h3 className="text-lg font-semibold text-drift-white mb-2">Earn</h3>
            <p className="text-drift-white/70">
              Your shares automatically accrue yield from multiple strategies.
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-yield-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-yield-gold font-bold text-xl">3</span>
            </div>
            <h3 className="text-lg font-semibold text-drift-white mb-2">Withdraw</h3>
            <p className="text-drift-white/70">
              Request withdrawal anytime. Claim USDC after cooldown.
            </p>
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="bg-lazy-navy-light/30 rounded-2xl p-8">
        <h2 className="text-2xl font-bold text-drift-white text-center mb-8">
          Why Lazy Protocol?
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature) => (
            <div key={feature.title} className="text-center">
              <div className="w-12 h-12 bg-yield-gold/10 rounded-xl flex items-center justify-center mx-auto mb-4">
                <feature.icon className="w-6 h-6 text-yield-gold" />
              </div>
              <h3 className="text-lg font-semibold text-drift-white mb-2">
                {feature.title}
              </h3>
              <p className="text-drift-white/70 text-sm">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
