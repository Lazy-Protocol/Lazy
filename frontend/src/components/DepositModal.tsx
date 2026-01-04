import { useState, useEffect } from 'react';
import { X, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  useUserData,
  useApprove,
  useDeposit,
  formatUsdc,
  parseUsdc,
} from '@/hooks/useVault';
import toast from 'react-hot-toast';

interface DepositModalProps {
  onClose: () => void;
}

type Step = 'input' | 'approve' | 'deposit' | 'success';

export function DepositModal({ onClose }: DepositModalProps) {
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('input');
  const { address } = useAccount();
  const { usdcBalance, usdcAllowance, refetch } = useUserData(address);

  const {
    approve,
    isPending: isApproving,
    isConfirming: isApproveConfirming,
    isSuccess: isApproveSuccess,
    error: approveError,
  } = useApprove();

  const {
    deposit,
    isPending: isDepositing,
    isConfirming: isDepositConfirming,
    isSuccess: isDepositSuccess,
    error: depositError,
  } = useDeposit();

  const parsedAmount = parseUsdc(amount);
  const needsApproval = usdcAllowance !== undefined && parsedAmount > usdcAllowance;
  const hasInsufficientBalance = usdcBalance !== undefined && parsedAmount > usdcBalance;
  const isValidAmount = parsedAmount > 0n && !hasInsufficientBalance;

  // Handle approve success
  useEffect(() => {
    if (isApproveSuccess && step === 'approve') {
      toast.success('USDC approved!');
      refetch();
      setStep('deposit');
      // Auto-trigger deposit after approval
      deposit(parsedAmount);
    }
  }, [isApproveSuccess, step]);

  // Handle deposit success
  useEffect(() => {
    if (isDepositSuccess && step === 'deposit') {
      toast.success('Deposit successful!');
      refetch();
      setStep('success');
    }
  }, [isDepositSuccess, step]);

  // Handle errors
  useEffect(() => {
    if (approveError) {
      toast.error('Approval failed');
      setStep('input');
    }
    if (depositError) {
      toast.error('Deposit failed');
      setStep('input');
    }
  }, [approveError, depositError]);

  const handleSubmit = () => {
    if (!isValidAmount) return;

    if (needsApproval) {
      setStep('approve');
      approve(parsedAmount);
    } else {
      setStep('deposit');
      deposit(parsedAmount);
    }
  };

  const handleMaxClick = () => {
    if (usdcBalance) {
      setAmount((Number(usdcBalance) / 1e6).toString());
    }
  };

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
          <h2 className="text-xl font-semibold text-drift-white">Deposit USDC</h2>
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
              Deposit Successful!
            </h3>
            <p className="text-drift-white/70 mb-6">
              You have deposited {amount} USDC into the vault.
            </p>
            <button
              onClick={onClose}
              className="w-full bg-yield-gold hover:bg-yield-gold-light text-lazy-navy font-semibold py-3 rounded-xl transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Amount Input */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-drift-white/70">Amount</label>
                <span className="text-sm text-drift-white/50">
                  Balance: {usdcBalance ? formatUsdc(usdcBalance) : '—'} USDC
                </span>
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
                  <span className="text-drift-white/50 text-sm">USDC</span>
                </div>
              </div>
              {hasInsufficientBalance && (
                <p className="text-error text-sm mt-2 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" />
                  Insufficient balance
                </p>
              )}
            </div>

            {/* Transaction Steps */}
            {step !== 'input' && (
              <div className="mb-6 space-y-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      step === 'approve'
                        ? 'bg-yield-gold text-lazy-navy'
                        : 'bg-success text-white'
                    }`}
                  >
                    {step === 'approve' ? (
                      isApproving || isApproveConfirming ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        '1'
                      )
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                  </div>
                  <span
                    className={
                      step === 'approve' ? 'text-drift-white' : 'text-drift-white/50'
                    }
                  >
                    Approve USDC
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      step === 'deposit'
                        ? 'bg-yield-gold text-lazy-navy'
                        : 'bg-lazy-navy text-drift-white/50'
                    }`}
                  >
                    {step === 'deposit' && (isDepositing || isDepositConfirming) ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      '2'
                    )}
                  </div>
                  <span
                    className={
                      step === 'deposit' ? 'text-drift-white' : 'text-drift-white/50'
                    }
                  >
                    Deposit to Vault
                  </span>
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={!isValidAmount || step !== 'input'}
              className="w-full bg-yield-gold hover:bg-yield-gold-light disabled:bg-yield-gold/50 disabled:cursor-not-allowed text-lazy-navy font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {step === 'input' ? (
                needsApproval ? (
                  'Approve & Deposit'
                ) : (
                  'Deposit'
                )
              ) : (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </>
              )}
            </button>

            {/* Info */}
            <p className="text-center text-drift-white/50 text-xs mt-4">
              You will receive lazyUSD shares representing your deposit.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
