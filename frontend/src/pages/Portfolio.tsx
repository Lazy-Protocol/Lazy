import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Wallet, TrendingUp, Clock, DollarSign } from 'lucide-react';
import { useUserData, useVaultStats, useUserWithdrawals, formatUsdc, formatShares } from '@/hooks/useVault';
import { formatUnits } from 'viem';
import { DepositModal } from '@/components/DepositModal';
import { WithdrawModal } from '@/components/WithdrawModal';

export function Portfolio() {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const { address, isConnected } = useAccount();
  const { shareBalance, usdcBalance, usdcValue, totalDeposited, isLoading } = useUserData(address);
  const { sharePrice, totalAssets, cooldownPeriod } = useVaultStats();
  const { queueDepth, userPendingCount } = useUserWithdrawals(address);

  // Calculate profit/loss
  const profitLoss = usdcValue && totalDeposited
    ? Number(usdcValue) - Number(totalDeposited)
    : 0;
  const profitLossPercent = totalDeposited && Number(totalDeposited) > 0
    ? (profitLoss / Number(totalDeposited)) * 100
    : 0;

  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center py-20">
          <div className="w-20 h-20 bg-lazy-navy-light rounded-full flex items-center justify-center mx-auto mb-6">
            <Wallet className="w-10 h-10 text-drift-white/50" />
          </div>
          <h2 className="text-2xl font-bold text-drift-white mb-4">
            Connect Your Wallet
          </h2>
          <p className="text-drift-white/70 mb-8 max-w-md mx-auto">
            Connect your wallet to view your portfolio, deposits, and withdrawal requests.
          </p>
          <ConnectButton />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold text-drift-white mb-8">Your Portfolio</h1>

      {/* Summary Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {/* Total Value */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Total Value</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            ${isLoading ? '...' : usdcValue ? formatUsdc(usdcValue) : '0.00'}
          </div>
          <div className={`text-sm mt-1 ${profitLoss >= 0 ? 'text-success' : 'text-error'}`}>
            {profitLoss >= 0 ? '+' : ''}{formatUsdc(BigInt(Math.abs(profitLoss)))} ({profitLossPercent.toFixed(2)}%)
          </div>
        </div>

        {/* Share Balance */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Share Balance</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            {isLoading ? '...' : shareBalance ? formatShares(shareBalance) : '0'}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            lazyUSD shares
          </div>
        </div>

        {/* USDC Balance */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <Wallet className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">USDC Balance</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            ${isLoading ? '...' : usdcBalance ? formatUsdc(usdcBalance) : '0.00'}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            Available to deposit
          </div>
        </div>

        {/* Pending Withdrawals */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <Clock className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Your Withdrawals</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            {userPendingCount !== undefined ? String(userPendingCount) : '...'}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            {userPendingCount && userPendingCount > 0n
              ? `pending (${queueDepth ?? '...'} total in queue)`
              : 'No pending requests'}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light mb-8">
        <h2 className="text-lg font-semibold text-drift-white mb-4">Quick Actions</h2>
        <div className="flex gap-4">
          <button
            onClick={() => setShowDeposit(true)}
            className="flex-1 bg-yield-gold hover:bg-yield-gold-light text-lazy-navy font-semibold py-3 rounded-xl transition-colors"
          >
            Deposit USDC
          </button>
          <button
            onClick={() => setShowWithdraw(true)}
            disabled={!shareBalance || shareBalance === 0n}
            className="flex-1 bg-lazy-navy hover:bg-lazy-navy/80 disabled:opacity-50 disabled:cursor-not-allowed text-drift-white font-semibold py-3 rounded-xl border border-lazy-navy-light transition-colors"
          >
            Request Withdrawal
          </button>
        </div>
      </div>

      {/* Vault Stats */}
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
        <h2 className="text-lg font-semibold text-drift-white mb-4">Vault Statistics</h2>
        <div className="grid md:grid-cols-3 gap-6">
          <div>
            <div className="text-drift-white/50 text-sm mb-1">Total Value Locked</div>
            <div className="text-xl font-semibold text-drift-white">
              ${totalAssets ? formatUsdc(totalAssets) : '...'}
            </div>
          </div>
          <div>
            <div className="text-drift-white/50 text-sm mb-1">Share Price</div>
            <div className="text-xl font-semibold text-drift-white">
              ${sharePrice ? Number(formatUnits(sharePrice, 18)).toFixed(4) : '...'}
            </div>
          </div>
          <div>
            <div className="text-drift-white/50 text-sm mb-1">Cooldown Period</div>
            <div className="text-xl font-semibold text-drift-white">
              {cooldownPeriod ? `${Number(cooldownPeriod) / 86400} days` : '...'}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} />}
      {showWithdraw && <WithdrawModal onClose={() => setShowWithdraw(false)} />}
    </div>
  );
}
