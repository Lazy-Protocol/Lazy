import { useState, useEffect } from 'react';
import { X, Info, Clock } from 'lucide-react';
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
import { formatUnits } from 'viem';
import toast from 'react-hot-toast';
import { ETHERSCAN_TX_URL } from '@/config/constants';

interface WithdrawModalProps {
  onClose: () => void;
}

export function WithdrawModal({ onClose }: WithdrawModalProps) {
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const { address } = useAccount();
  const { shareBalance, usdcValue, refetch } = useUserData(address);
  const { sharePrice, cooldownPeriod } = useVaultStats();

  const {
    requestWithdrawal,
    hash,
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

  // sharePrice is scaled to 6 decimals (1e6 = 1 USDC per share)
  const exchangeRate = sharePrice
    ? Number(formatUnits(sharePrice, 6)).toFixed(4)
    : '1.0000';

  const cooldownDays = cooldownPeriod ? Number(cooldownPeriod) / 86400 : 7;

  // Handle success
  useEffect(() => {
    if (isSuccess && isProcessing) {
      toast.success(
        <span>
          Withdrawal requested!{' '}
          <a href={ETHERSCAN_TX_URL(hash!)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--yield-gold)', textDecoration: 'underline' }}>
            View tx
          </a>
        </span>
      );
      refetch();
      setIsProcessing(false);
      onClose();
    }
  }, [isSuccess]);

  // Handle errors
  useEffect(() => {
    if (error) {
      toast.error('Withdrawal request failed');
      setIsProcessing(false);
    }
  }, [error]);

  const handleSubmit = () => {
    if (!isValidAmount) return;
    setIsProcessing(true);
    requestWithdrawal(parsedAmount);
  };

  const handleMaxClick = () => {
    if (shareBalance) {
      setAmount((Number(shareBalance) / 1e18).toString());
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title">Withdraw</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="input-group">
          <label className="input-label">lazyUSD Amount</label>
          <div className="input-wrapper">
            <input
              type="text"
              className="input"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={isProcessing}
            />
            <button className="input-max" onClick={handleMaxClick} disabled={isProcessing}>
              MAX
            </button>
          </div>
          <div className="input-helper">
            <span>Balance: {shareBalance ? formatShares(shareBalance) : '0.00'} lazyUSD</span>
            <span>≈ ${usdcValue ? formatUsdc(usdcValue) : '0.00'}</span>
          </div>
        </div>

        <div className="conversion-box">
          <div className="conversion-row">
            <span className="conversion-label">You'll receive</span>
            <span className="conversion-value">
              ~{estimatedUsdc.data ? formatUsdc(estimatedUsdc.data as bigint) : '0.00'} USDC
            </span>
          </div>
          <div className="conversion-row">
            <span className="conversion-label">Exchange rate</span>
            <span className="conversion-value">1 lazyUSD = {exchangeRate} USDC</span>
          </div>
          <div className="conversion-row">
            <span className="conversion-label">Cooldown period</span>
            <span className="conversion-value" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={14} />
              {cooldownDays} days
            </span>
          </div>
        </div>

        <div className="modal-info" style={{ background: 'rgba(196, 160, 82, 0.08)' }}>
          <Info size={20} style={{ color: 'var(--yield-gold)' }} />
          <div>
            <p style={{ fontWeight: 500, color: 'var(--yield-gold)', marginBottom: '4px' }}>Two-step withdrawal</p>
            <p>
              1. Request withdrawal (shares are escrowed)<br />
              2. Claim USDC after {cooldownDays}-day cooldown
            </p>
          </div>
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={handleSubmit}
          disabled={!isValidAmount || isProcessing}
        >
          {isProcessing ? 'Processing...' : 'Request Withdrawal'}
        </button>

        {hasInsufficientBalance && (
          <p className="text-red-500 text-sm text-center mt-3">
            Insufficient lazyUSD balance
          </p>
        )}

        <p className="text-slate-400 text-xs text-center mt-3">
          Shares in the withdrawal queue still earn yield until fulfilled.
        </p>
      </div>
    </div>
  );
}
