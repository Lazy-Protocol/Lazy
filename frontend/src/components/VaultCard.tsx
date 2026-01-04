import { useState } from 'react';
import { TrendingUp, Shield, Clock, DollarSign } from 'lucide-react';
import { useVaultStats, formatUsdc } from '@/hooks/useVault';
import { formatUnits } from 'viem';
import { DepositModal } from './DepositModal';
import { WithdrawModal } from './WithdrawModal';
import { useAccount } from 'wagmi';

interface VaultCardProps {
  name: string;
  symbol: string;
  description: string;
  apy?: string;
  comingSoon?: boolean;
}

export function VaultCard({ name, symbol, description, apy = '—', comingSoon = false }: VaultCardProps) {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const { isConnected } = useAccount();
  const { totalAssets, sharePrice, cooldownPeriod, isLoading } = useVaultStats();

  // Format share price to readable APY indicator
  const formattedSharePrice = sharePrice
    ? `$${Number(formatUnits(sharePrice, 18)).toFixed(4)}`
    : '—';

  const formattedTvl = totalAssets ? formatUsdc(totalAssets) : '—';
  const formattedCooldown = cooldownPeriod
    ? `${Number(cooldownPeriod) / 86400} days`
    : '—';

  if (comingSoon) {
    return (
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light opacity-60">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-lazy-navy flex items-center justify-center">
              <DollarSign className="w-6 h-6 text-drift-white/50" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-drift-white">{name}</h3>
              <span className="text-sm text-drift-white/50">{symbol}</span>
            </div>
          </div>
          <span className="bg-yield-gold/20 text-yield-gold text-xs font-medium px-3 py-1 rounded-full">
            Coming Soon
          </span>
        </div>
        <p className="text-drift-white/70 text-sm mb-4">{description}</p>
        <div className="h-px bg-lazy-navy-light my-4" />
        <button
          disabled
          className="w-full bg-lazy-navy text-drift-white/50 font-semibold py-3 rounded-xl cursor-not-allowed"
        >
          Coming Soon
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light hover:border-yield-gold/30 transition-colors">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-yield-gold/10 flex items-center justify-center">
              <DollarSign className="w-6 h-6 text-yield-gold" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-drift-white">{name}</h3>
              <span className="text-sm text-drift-white/50">{symbol}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-success">{apy}</div>
            <div className="text-xs text-drift-white/50">APY</div>
          </div>
        </div>

        {/* Description */}
        <p className="text-drift-white/70 text-sm mb-4">{description}</p>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-lazy-navy rounded-xl p-3">
            <div className="flex items-center gap-2 text-drift-white/50 text-xs mb-1">
              <TrendingUp className="w-3 h-3" />
              TVL
            </div>
            <div className="text-drift-white font-medium">
              {isLoading ? '...' : `$${formattedTvl}`}
            </div>
          </div>
          <div className="bg-lazy-navy rounded-xl p-3">
            <div className="flex items-center gap-2 text-drift-white/50 text-xs mb-1">
              <Shield className="w-3 h-3" />
              Share Price
            </div>
            <div className="text-drift-white font-medium">
              {isLoading ? '...' : formattedSharePrice}
            </div>
          </div>
          <div className="bg-lazy-navy rounded-xl p-3">
            <div className="flex items-center gap-2 text-drift-white/50 text-xs mb-1">
              <Clock className="w-3 h-3" />
              Cooldown
            </div>
            <div className="text-drift-white font-medium">
              {isLoading ? '...' : formattedCooldown}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={() => setShowDeposit(true)}
            disabled={!isConnected}
            className="flex-1 bg-yield-gold hover:bg-yield-gold-light disabled:bg-yield-gold/50 disabled:cursor-not-allowed text-lazy-navy font-semibold py-3 rounded-xl transition-colors"
          >
            {isConnected ? 'Deposit' : 'Connect to Deposit'}
          </button>
          <button
            onClick={() => setShowWithdraw(true)}
            disabled={!isConnected}
            className="flex-1 bg-lazy-navy hover:bg-lazy-navy/80 disabled:opacity-50 disabled:cursor-not-allowed text-drift-white font-semibold py-3 rounded-xl border border-lazy-navy-light transition-colors"
          >
            Withdraw
          </button>
        </div>
      </div>

      {/* Modals */}
      {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} />}
      {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} />}
    </>
  );
}
