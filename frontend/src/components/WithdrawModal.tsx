import { useState, useEffect, useRef } from 'react';
import { X, Info, Clock } from 'lucide-react';
import { useAccount, usePublicClient } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { useChainModal, useConnectModal } from '@rainbow-me/rainbowkit';
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
  const submitting = useRef(false);
  const mounted = useRef(false);
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: mainnet.id });
  const { openConnectModal } = useConnectModal();
  const { openChainModal } = useChainModal();
  const { shareBalance, usdcValue, isLoading, refetch } = useUserData(address);
  const { sharePrice, cooldownPeriod } = useVaultStats();

  const { requestWithdrawal } = useRequestWithdrawal();

  const parsedAmount = parseShares(amount);
  const hasInsufficientBalance = shareBalance !== undefined && parsedAmount > shareBalance;
  const isMainnet = chainId === mainnet.id;
  const isValidAmount = isConnected && isMainnet && shareBalance !== undefined && parsedAmount > 0n && !hasInsufficientBalance;

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

  const cooldownDays = cooldownPeriod !== undefined ? Number(cooldownPeriod) / 86400 : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const handleSubmit = async () => {
    if (!isValidAmount || !address || !client || submitting.current) return;
    submitting.current = true;
    setIsProcessing(true);
    let awaitingReceipt = false;
    try {
      const hash = await requestWithdrawal(parsedAmount, address);
      awaitingReceipt = true;
      const receipt = await client.waitForTransactionReceipt({ hash });
      awaitingReceipt = false;
      if (receipt.status !== 'success') {
        toast.error('Withdrawal request reverted. Review and retry.');
        return;
      }
      toast.success(
        <span>
          Withdrawal queued.{' '}
          <a href={ETHERSCAN_TX_URL(receipt.transactionHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--yield-gold)', textDecoration: 'underline' }}>
            View tx
          </a>
        </span>
      );
      refetch();
      if (mounted.current) onClose();
    } catch {
      toast.error(awaitingReceipt
        ? 'Could not confirm the request. Check your wallet or explorer before retrying.'
        : 'Request did not complete. Review and retry.');
    } finally {
      submitting.current = false;
      if (mounted.current) setIsProcessing(false);
    }
  };

  const handleMaxClick = () => {
    if (shareBalance) {
      setAmount(formatUnits(shareBalance, 18));
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="withdraw-title">
        <div className="modal-header">
          <h3 className="modal-title" id="withdraw-title">Withdraw</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close withdrawal">
            <X size={20} />
          </button>
        </div>

        <div className="input-group">
          <label className="input-label" htmlFor="withdraw-amount">lazyUSD Amount</label>
          <div className="input-wrapper">
            <input
              type="text"
              id="withdraw-amount"
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
              {cooldownDays !== undefined ? `${cooldownDays} days` : 'Loading...'}
            </span>
          </div>
        </div>

        <div className="modal-info" style={{ background: 'rgba(196, 160, 82, 0.08)' }}>
          <Info size={20} style={{ color: 'var(--yield-gold)' }} />
          <div>
            <p style={{ fontWeight: 500, color: 'var(--yield-gold)', marginBottom: '4px' }}>Queued withdrawal</p>
            <p>
              Request a withdrawal to escrow your shares. After the cooldown, the operator
              processes requests in order and sends USDC directly to your wallet.
              You do not need to submit a separate claim.
            </p>
          </div>
        </div>

        {!isConnected ? (
          <button className="btn btn-primary w-full" onClick={openConnectModal}>Connect Wallet</button>
        ) : !isMainnet ? (
          <button className="btn btn-primary w-full" onClick={openChainModal}>Switch to Ethereum</button>
        ) : <button
          className="btn btn-primary w-full"
          onClick={handleSubmit}
          disabled={!isValidAmount || isProcessing || !client}
        >
          {isProcessing ? 'Confirming...' : shareBalance === undefined ? (isLoading ? 'Loading balance...' : 'Balance unavailable') : 'Request Withdrawal'}
        </button>}

        {isConnected && isMainnet && shareBalance === undefined && !isLoading && (
          <button className="btn btn-secondary w-full mt-3" onClick={refetch}>Refresh balance</button>
        )}

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
