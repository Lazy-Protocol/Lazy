import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  Users,
  DollarSign,
  TrendingUp,
  Clock,
  Copy,
  Check,
  ExternalLink,
  Wallet,
} from 'lucide-react';
import { useKOLData, useKOLEarnings, formatUsdcAmount } from '@/hooks/useKOL';

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Now';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function KOL() {
  const { address, isConnected } = useAccount();
  const kolData = useKOLData(address);
  const earnings = useKOLEarnings(address);
  const [copied, setCopied] = useState(false);

  const referralLink = kolData.handle
    ? `https://getlazy.xyz?ref=${kolData.handle}`
    : '';

  const handleCopy = async () => {
    if (!referralLink) return;
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Not connected state
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
            Connect your wallet to view your KOL dashboard.
          </p>
          <ConnectButton />
        </div>
      </div>
    );
  }

  // Not a KOL state
  if (!kolData.isKOL) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center py-20">
          <div className="w-20 h-20 bg-lazy-navy-light rounded-full flex items-center justify-center mx-auto mb-6">
            <Users className="w-10 h-10 text-drift-white/50" />
          </div>
          <h2 className="text-2xl font-bold text-drift-white mb-4">
            KOL Program
          </h2>
          <p className="text-drift-white/70 mb-8 max-w-md mx-auto">
            This wallet is not registered as a KOL partner. The referral program
            is invite-only. Contact the team if you're interested in partnering.
          </p>
          <a
            href="https://t.me/+KKGjFua0yv4zNmFi"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary inline-flex items-center gap-2"
          >
            Contact Us <ExternalLink size={16} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-drift-white">KOL Dashboard</h1>
          <p className="text-drift-white/70 mt-1">
            Welcome back, <span className="text-yield-gold">@{kolData.handle}</span>
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm text-drift-white/50">Your share</div>
          <div className="text-xl font-bold text-yield-gold">
            {kolData.feeSharePercent}% of fees
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {/* Total Referrals */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <Users className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Total Referrals</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            {kolData.totalReferred}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            depositors referred
          </div>
        </div>

        {/* Total AUM */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Referral AUM</span>
          </div>
          <div className="text-2xl font-bold text-drift-white">
            ${formatUsdcAmount(earnings.totalAUM)}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            total deposits from referrals
          </div>
        </div>

        {/* Total Earned */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Total Earned</span>
          </div>
          <div className="text-2xl font-bold text-success">
            ${kolData.totalEarnedFormatted}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            lifetime earnings
          </div>
        </div>

        {/* Pending Earnings */}
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-yield-gold/10 rounded-xl flex items-center justify-center">
              <Clock className="w-5 h-5 text-yield-gold" />
            </div>
            <span className="text-drift-white/70">Pending</span>
          </div>
          <div className="text-2xl font-bold text-yield-gold">
            ${earnings.pendingEarningsFormatted}
          </div>
          <div className="text-sm text-drift-white/50 mt-1">
            {earnings.canDistribute
              ? 'ready to distribute'
              : `in ${formatTimeRemaining(earnings.timeUntilDistribution)}`}
          </div>
        </div>
      </div>

      {/* Referral Link */}
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light mb-8">
        <h2 className="text-lg font-semibold text-drift-white mb-4">
          Your Referral Link
        </h2>
        <div className="flex items-center gap-4">
          <div className="flex-1 bg-lazy-navy rounded-xl px-4 py-3 font-mono text-sm text-drift-white/90 overflow-x-auto">
            {referralLink}
          </div>
          <button
            onClick={handleCopy}
            className="btn btn-primary flex items-center gap-2"
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-sm text-drift-white/50 mt-3">
          Share this link with your audience. When they deposit, you'll earn{' '}
          {kolData.feeSharePercent}% of the protocol fees from their yield.
        </p>
      </div>

      {/* Distribution Info */}
      <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light mb-8">
        <h2 className="text-lg font-semibold text-drift-white mb-4">
          Fee Distribution
        </h2>
        <div className="grid md:grid-cols-3 gap-6">
          <div>
            <div className="text-drift-white/50 text-sm mb-1">
              This Period's Yield
            </div>
            <div className="text-xl font-semibold text-drift-white">
              ${earnings.referralYieldFormatted}
            </div>
            <div className="text-xs text-drift-white/40">
              from your referrals
            </div>
          </div>
          <div>
            <div className="text-drift-white/50 text-sm mb-1">
              Your Share (Est.)
            </div>
            <div className="text-xl font-semibold text-yield-gold">
              ${earnings.pendingEarningsFormatted}
            </div>
            <div className="text-xs text-drift-white/40">
              {kolData.feeSharePercent}% of 20% protocol fee
            </div>
          </div>
          <div>
            <div className="text-drift-white/50 text-sm mb-1">
              Next Distribution
            </div>
            <div className="text-xl font-semibold text-drift-white">
              {earnings.canDistribute
                ? 'Available now'
                : formatTimeRemaining(earnings.timeUntilDistribution)}
            </div>
            <div className="text-xs text-drift-white/40">
              weekly automated payouts
            </div>
          </div>
        </div>
      </div>

      {/* Referrals Table */}
      {kolData.referrals.length > 0 && (
        <div className="bg-lazy-navy-light/50 rounded-2xl p-6 border border-lazy-navy-light">
          <h2 className="text-lg font-semibold text-drift-white mb-4">
            Your Referrals ({kolData.referrals.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-lazy-navy-light">
                  <th className="text-left text-drift-white/50 text-sm font-medium py-3 px-4">
                    Address
                  </th>
                  <th className="text-right text-drift-white/50 text-sm font-medium py-3 px-4">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {kolData.referrals.slice(0, 20).map((referral) => (
                  <tr
                    key={referral}
                    className="border-b border-lazy-navy-light/50"
                  >
                    <td className="py-3 px-4">
                      <a
                        href={`https://etherscan.io/address/${referral}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-drift-white hover:text-yield-gold font-mono text-sm flex items-center gap-2"
                      >
                        {shortenAddress(referral)}
                        <ExternalLink size={12} />
                      </a>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-success/10 text-success">
                        Active
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {kolData.referrals.length > 20 && (
              <p className="text-center text-drift-white/50 text-sm py-4">
                Showing 20 of {kolData.referrals.length} referrals
              </p>
            )}
          </div>
        </div>
      )}

      {/* How It Works */}
      <div className="mt-8 bg-lazy-navy/50 rounded-2xl p-6 border border-lazy-navy-light">
        <h3 className="text-lg font-semibold text-drift-white mb-4">
          How Fee Sharing Works
        </h3>
        <div className="grid md:grid-cols-4 gap-4 text-sm">
          <div className="text-center p-4">
            <div className="w-8 h-8 bg-yield-gold/20 rounded-full flex items-center justify-center mx-auto mb-2 text-yield-gold font-bold">
              1
            </div>
            <p className="text-drift-white/70">
              User deposits via your link
            </p>
          </div>
          <div className="text-center p-4">
            <div className="w-8 h-8 bg-yield-gold/20 rounded-full flex items-center justify-center mx-auto mb-2 text-yield-gold font-bold">
              2
            </div>
            <p className="text-drift-white/70">
              Their deposit earns yield
            </p>
          </div>
          <div className="text-center p-4">
            <div className="w-8 h-8 bg-yield-gold/20 rounded-full flex items-center justify-center mx-auto mb-2 text-yield-gold font-bold">
              3
            </div>
            <p className="text-drift-white/70">
              Protocol takes 20% fee on yield
            </p>
          </div>
          <div className="text-center p-4">
            <div className="w-8 h-8 bg-yield-gold/20 rounded-full flex items-center justify-center mx-auto mb-2 text-yield-gold font-bold">
              4
            </div>
            <p className="text-drift-white/70">
              You get {kolData.feeSharePercent}% of that fee weekly
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
