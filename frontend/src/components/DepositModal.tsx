import { useState, useEffect } from 'react';
import { X, Info } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  useUserData,
  useVaultStats,
  useApprove,
  useDeposit,
  formatUsdc,
  parseUsdc,
} from '@/hooks/useVault';
import { formatUnits } from 'viem';
import toast from 'react-hot-toast';

interface DepositModalProps {
  onClose: () => void;
}

export function DepositModal({ onClose }: DepositModalProps) {
  const [amount, setAmount] = useState('1000');
  const [isProcessing, setIsProcessing] = useState(false);
  const { address } = useAccount();
  const { usdcBalance, usdcAllowance, refetch } = useUserData(address);
  const { sharePrice } = useVaultStats();

  const {
    approve,
    isSuccess: isApproveSuccess,
    error: approveError,
  } = useApprove();

  const {
    deposit,
    isSuccess: isDepositSuccess,
    error: depositError,
  } = useDeposit();

  const parsedAmount = parseUsdc(amount);
  const needsApproval = usdcAllowance !== undefined && parsedAmount > usdcAllowance;
  const hasInsufficientBalance = usdcBalance !== undefined && parsedAmount > usdcBalance;
  const isValidAmount = parsedAmount > 0n && !hasInsufficientBalance;

  // Calculate shares to receive
  const sharesToReceive = sharePrice && parsedAmount > 0n
    ? (parsedAmount * BigInt(1e18)) / sharePrice
    : 0n;

  const exchangeRate = sharePrice
    ? Number(formatUnits(sharePrice, 18)).toFixed(4)
    : '1.0000';

  // Handle approve success
  useEffect(() => {
    if (isApproveSuccess && isProcessing) {
      toast.success('USDC approved!');
      refetch();
      deposit(parsedAmount);
    }
  }, [isApproveSuccess]);

  // Handle deposit success
  useEffect(() => {
    if (isDepositSuccess && isProcessing) {
      toast.success('Deposit successful!');
      refetch();
      setIsProcessing(false);
      onClose();
    }
  }, [isDepositSuccess]);

  // Handle errors
  useEffect(() => {
    if (approveError || depositError) {
      toast.error('Transaction failed');
      setIsProcessing(false);
    }
  }, [approveError, depositError]);

  const handleSubmit = () => {
    if (!isValidAmount) return;
    setIsProcessing(true);

    if (needsApproval) {
      approve(parsedAmount);
    } else {
      deposit(parsedAmount);
    }
  };

  const handleMaxClick = () => {
    if (usdcBalance) {
      setAmount((Number(usdcBalance) / 1e6).toString());
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title">Deposit USDC</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="input-group">
          <label className="input-label">Amount</label>
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
            <span>Balance: {usdcBalance ? formatUsdc(usdcBalance) : '0.00'} USDC</span>
            <span>≈ ${amount || '0.00'}</span>
          </div>
        </div>

        <div className="conversion-box">
          <div className="conversion-row">
            <span className="conversion-label">You'll receive</span>
            <span className="conversion-value">
              ~{sharesToReceive ? Number(formatUnits(sharesToReceive, 18)).toFixed(2) : '0.00'} lazyUSD
            </span>
          </div>
          <div className="conversion-row">
            <span className="conversion-label">Exchange rate</span>
            <span className="conversion-value">1 lazyUSD = {exchangeRate} USDC</span>
          </div>
          <div className="conversion-row">
            <span className="conversion-label">Current APY</span>
            <span className="conversion-value" style={{ color: 'var(--earn-green)' }}>5.2%</span>
          </div>
        </div>

        <div className="modal-info">
          <Info size={20} />
          <p>Your lazyUSD will grow in value as yield accrues. No action needed—it's automatic.</p>
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleSubmit}
          disabled={!isValidAmount || isProcessing}
        >
          {isProcessing ? 'Processing...' : needsApproval ? 'Approve & Deposit' : 'Confirm Deposit'}
        </button>

        {hasInsufficientBalance && (
          <p style={{ color: 'var(--risk-red)', fontSize: '0.875rem', textAlign: 'center', marginTop: '12px' }}>
            Insufficient USDC balance
          </p>
        )}
      </div>
    </div>
  );
}
