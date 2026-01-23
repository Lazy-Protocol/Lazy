import { useState, useEffect, useRef } from 'react';
import { X, Info, Share2, Download, Check } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  useUserData,
  useVaultStats,
  useApprove,
  useDeposit,
  formatUsdc,
  parseUsdc,
} from '@/hooks/useVault';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { formatUnits } from 'viem';
import toast from 'react-hot-toast';
import { ETHERSCAN_TX_URL } from '@/config/constants';
import html2canvas from 'html2canvas';

interface DepositModalProps {
  onClose: () => void;
}

export function DepositModal({ onClose }: DepositModalProps) {
  const [amount, setAmount] = useState('1000');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [depositedAmount, setDepositedAmount] = useState('0');
  const [copied, setCopied] = useState(false);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const { address } = useAccount();
  const { usdcBalance, usdcAllowance, refetch } = useUserData(address);
  const { sharePrice } = useVaultStats();
  const { data: protocolStats } = useProtocolStats();

  const {
    approve,
    hash: approveHash,
    isSuccess: isApproveSuccess,
    error: approveError,
  } = useApprove();

  const {
    deposit,
    hash: depositHash,
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

  // sharePrice is scaled to 6 decimals (1e6 = 1 USDC per share)
  const exchangeRate = sharePrice
    ? Number(formatUnits(sharePrice, 6)).toFixed(4)
    : '1.0000';

  // Handle approve success
  useEffect(() => {
    if (isApproveSuccess && isProcessing) {
      toast.success(
        <span>
          USDC approved.{' '}
          <a href={ETHERSCAN_TX_URL(approveHash!)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--yield-gold)', textDecoration: 'underline' }}>
            View tx
          </a>
        </span>
      );
      refetch();
      deposit(parsedAmount);
    }
  }, [isApproveSuccess]);

  // Handle deposit success
  useEffect(() => {
    if (isDepositSuccess && isProcessing) {
      toast.success(
        <span>
          Deposit confirmed.{' '}
          <a href={ETHERSCAN_TX_URL(depositHash!)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--yield-gold)', textDecoration: 'underline' }}>
            View tx
          </a>
        </span>
      );
      refetch();
      setIsProcessing(false);
      setDepositedAmount(amount);
      setShowSuccess(true);
    }
  }, [isDepositSuccess]);

  // Handle errors
  useEffect(() => {
    if (approveError || depositError) {
      toast.error('Transaction did not complete. Review and retry.');
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

  // Share card functions
  const tweetText = `$${Number(depositedAmount).toLocaleString()} deposited into @getlazy.

Now I wait.

No staking. No claiming. Just yield.

getlazy.xyz?utm_source=share&utm_medium=twitter #PatientCapital`;

  const handleDownload = async () => {
    if (!shareCardRef.current) return;
    try {
      const canvas = await html2canvas(shareCardRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: null,
      });
      const link = document.createElement('a');
      link.download = `lazy-deposit-${depositedAmount}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (error) {
      console.error('Failed to generate image:', error);
    }
  };

  const handleTwitterShare = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
    window.open(url, '_blank', 'width=550,height=420');
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(tweetText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Success share card styles (inline for html2canvas)
  const cardStyles = {
    card: {
      width: '500px',
      height: '280px',
      background: '#1a2332',
      position: 'relative' as const,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflow: 'hidden',
      borderRadius: '12px',
    },
    grid: {
      position: 'absolute' as const,
      inset: 0,
      backgroundImage: `
        linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)
      `,
      backgroundSize: '20px 20px',
      pointerEvents: 'none' as const,
    },
    logo: {
      position: 'absolute' as const,
      top: '20px',
      left: '24px',
      fontSize: '16px',
      fontWeight: 700,
      color: '#FAFBFC',
    },
    content: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      padding: '20px 24px',
      textAlign: 'center' as const,
    },
    badge: {
      display: 'inline-block',
      padding: '6px 12px',
      background: 'rgba(196, 160, 82, 0.15)',
      border: '1px solid rgba(196, 160, 82, 0.3)',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 600,
      color: '#C4A052',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
      marginBottom: '16px',
    },
    amount: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '42px',
      fontWeight: 700,
      color: '#C4A052',
      lineHeight: 1,
      marginBottom: '8px',
    },
    label: {
      fontSize: '14px',
      fontWeight: 400,
      color: 'rgba(232, 230, 225, 0.6)',
      marginBottom: '20px',
    },
    tagline: {
      fontSize: '13px',
      fontWeight: 500,
      fontStyle: 'italic' as const,
      color: 'rgba(232, 230, 225, 0.5)',
    },
    url: {
      position: 'absolute' as const,
      bottom: '16px',
      right: '20px',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '10px',
      fontWeight: 400,
      color: 'rgba(232, 230, 225, 0.4)',
    },
  };

  // Show success share card
  if (showSuccess) {
    return (
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal" style={{ maxWidth: '560px' }}>
          <div className="modal-header">
            <h3 className="modal-title">Deposit Confirmed</h3>
            <button className="modal-close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>

          <p style={{ color: 'var(--slate)', marginBottom: 'var(--space-md)', textAlign: 'center' }}>
            Share your move with the patient capital club.
          </p>

          {/* Share Card Preview */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-lg)' }}>
            <div ref={shareCardRef} style={cardStyles.card}>
              <div style={cardStyles.grid} />
              <div style={cardStyles.logo}>Lazy</div>
              <div style={cardStyles.content}>
                <div style={cardStyles.badge}>Patient Capital</div>
                <div style={cardStyles.amount}>${Number(depositedAmount).toLocaleString()}</div>
                <div style={cardStyles.label}>deposited</div>
                <p style={cardStyles.tagline}>"Now I wait."</p>
              </div>
              <div style={cardStyles.url}>getlazy.xyz</div>
            </div>
          </div>

          {/* Share Actions */}
          <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
            <button className="btn btn-primary" onClick={handleTwitterShare} style={{ flex: 1 }}>
              <Share2 size={16} />
              Share on X
            </button>
            <button className="btn btn-secondary" onClick={handleDownload} style={{ flex: 1 }}>
              <Download size={16} />
              Download
            </button>
            <button className="btn btn-secondary" onClick={handleCopy} style={{ flex: 1 }}>
              {copied ? <Check size={16} /> : <Share2 size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <button className="btn btn-secondary w-full" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

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
            <span className="conversion-label">{protocolStats?.aprPeriod === '7d' ? '7d APR' : 'APR'}</span>
            <span className="conversion-value" style={{ color: 'var(--earn-green)' }}>{protocolStats?.apr ? `${protocolStats.apr}%` : '...'}</span>
          </div>
        </div>

        <div className="modal-info">
          <Info size={20} />
          <p>Your lazyUSD grows as yield accrues. No action required.</p>
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={handleSubmit}
          disabled={!isValidAmount || isProcessing}
        >
          {isProcessing ? 'Confirming...' : needsApproval ? 'Approve & Deposit' : 'Confirm Deposit'}
        </button>

        {hasInsufficientBalance && (
          <p className="text-red-500 text-sm text-center mt-3">
            Insufficient USDC balance
          </p>
        )}
      </div>
    </div>
  );
}
