import { useState, useEffect } from 'react';
import { X, Loader2, Check, AlertCircle, Clock, Info } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  useUserData,
  useVaultStats,
  useRequestWithdrawal,
  formatShares,
  formatUsdc,
  parseShares,
} from '@/hooks/useVault';
import { useReadContract } from 'wagmi';
import { vaultAbi } from '@/config/abis';
import { CONTRACTS } from '@/config/wagmi';
import toast from 'react-hot-toast';

interface WithdrawModalProps {
  onClose: () => void;
}

type Step = 'input' | 'requesting' | 'success';

export function WithdrawModal({ onClose }: WithdrawModalProps) {
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('input');
  const { address } = useAccount();
  const { shareBalance, usdcValue, refetch } = useUserData(address);
  const { cooldownPeriod } = useVaultStats();

  const {
    requestWithdrawal,
    isSuccess,
    error,
  } = useRequestWithdrawal();

  const parsedAmount = parseShares(amount);
  const hasInsufficientBalance = shareBalance !== undefined && parsedAmount > shareBalance;
  const isValidAmount = parsedAmount > 0n && !hasInsufficientBalance;

  // Get estimated USDC value for input amount
  const estimatedUsdc = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: 'sharesToUsdc',
    args: parsedAmount > 0n ? [parsedAmount] : undefined,
    query: {
      enabled: parsedAmount > 0n,
    },
  });

  // Handle success
  useEffect(() => {
    if (isSuccess && step === 'requesting') {
      toast.success('Withdrawal requested!');
      refetch();
      setStep('success');
    }
  }, [isSuccess, step]);

  // Handle errors
  useEffect(() => {
    if (error) {
      toast.error('Withdrawal request failed');
      setStep('input');
    }
  }, [error]);

  const handleSubmit = () => {
    if (!isValidAmount) return;
    setStep('requesting');
    requestWithdrawal(parsedAmount);
  };

  const handleMaxClick = () => {
    if (shareBalance) {
      setAmount((Number(shareBalance) / 1e18).toString());
    }
  };

  const cooldownDays = cooldownPeriod ? Number(cooldownPeriod) / 86400 : 7;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-lazy-navy-light border border-lazy-navy-light rounded-2xl w-full max-w-md mx-4 p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-drift-white">Request Withdrawal</h2>
          <button
            onClick={onClose}
            className="text-drift-white/50 hover:text-drift-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === 'success' ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-success/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-success" />
            </div>
            <h3 className="text-lg font-semibold text-drift-white mb-2">
              Withdrawal Requested!
            </h3>
            <p className="text-drift-white/70 mb-4">
              Your shares have been escrowed. You can claim your USDC after the cooldown period.
            </p>
            <div className="bg-lazy-navy rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 text-yield-gold mb-2">
                <Clock className="w-4 h-4" />
                <span className="font-medium">Cooldown Period</span>
              </div>
              <p className="text-drift-white/70 text-sm">
                ~{cooldownDays} days until eligible for fulfillment
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full bg-yield-gold hover:bg-yield-gold-light text-lazy-navy font-semibold py-3 rounded-xl transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Info Banner */}
            <div className="bg-yield-gold/10 border border-yield-gold/20 rounded-xl p-4 mb-6">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-yield-gold flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="text-yield-gold font-medium mb-1">Two-step withdrawal</p>
                  <p className="text-drift-white/70">
                    1. Request withdrawal (shares are escrowed)
                    <br />
                    2. Claim USDC after {cooldownDays}-day cooldown
                  </p>
                </div>
              </div>
            </div>

            {/* Balance Display */}
            <div className="bg-lazy-navy rounded-xl p-4 mb-6">
              <div className="flex justify-between items-center">
                <span className="text-drift-white/70">Your Position</span>
                <div className="text-right">
                  <div className="text-drift-white font-medium">
                    {shareBalance ? formatShares(shareBalance) : '—'} shares
                  </div>
                  <div className="text-drift-white/50 text-sm">
                    ≈ ${usdcValue ? formatUsdc(usdcValue) : '—'} USDC
                  </div>
                </div>
              </div>
            </div>

            {/* Amount Input */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-drift-white/70">Shares to withdraw</label>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0.00"
                  disabled={step !== 'input'}
                  className="w-full bg-lazy-navy border border-lazy-navy-light rounded-xl px-4 py-3 text-drift-white text-lg placeholder:text-drift-white/30 focus:outline-none focus:border-yield-gold disabled:opacity-50"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                  <button
                    onClick={handleMaxClick}
                    disabled={step !== 'input'}
                    className="text-xs text-yield-gold hover:text-yield-gold-light disabled:opacity-50"
                  >
                    MAX
                  </button>
                  <span className="text-drift-white/50 text-sm">shares</span>
                </div>
              </div>
              {hasInsufficientBalance && (
                <p className="text-error text-sm mt-2 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" />
                  Insufficient balance
                </p>
              )}
              {parsedAmount > 0n && estimatedUsdc.data && (
                <p className="text-drift-white/50 text-sm mt-2">
                  ≈ ${formatUsdc(estimatedUsdc.data as bigint)} USDC at current price
                </p>
              )}
            </div>

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={!isValidAmount || step !== 'input'}
              className="w-full bg-yield-gold hover:bg-yield-gold-light disabled:bg-yield-gold/50 disabled:cursor-not-allowed text-lazy-navy font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {step === 'input' ? (
                'Request Withdrawal'
              ) : (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </>
              )}
            </button>

            {/* Warning */}
            <p className="text-center text-drift-white/50 text-xs mt-4">
              Shares in the withdrawal queue still earn yield until fulfilled.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
