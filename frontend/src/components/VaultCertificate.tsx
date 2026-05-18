import { X } from 'lucide-react';
import { formatUsdc } from '@/hooks/useVault';
import { useWalletYield } from '@/hooks/useWalletYield';

interface VaultCertificateProps {
  address: `0x${string}` | undefined;
  shareBalance: bigint | undefined;
  usdcValue: bigint | undefined;
  onClose: () => void;
}

export function VaultCertificate({ address, shareBalance, usdcValue, onClose }: VaultCertificateProps) {
  const { totalYield, profitLossPercent, realizedApr, daysHeld } = useWalletYield(address);

  const shares = shareBalance ? Number(shareBalance) / 1e18 : 0;
  const issuedDate = '2026.01.07';

  return (
    <div className="cert-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <button className="cert-close" onClick={onClose} aria-label="Close certificate">
        <X size={20} />
      </button>

      <article className="cert">
        <span className="cert-corner cert-corner-tl" aria-hidden />
        <span className="cert-corner cert-corner-tr" aria-hidden />
        <span className="cert-corner cert-corner-bl" aria-hidden />
        <span className="cert-corner cert-corner-br" aria-hidden />

        <header className="cert-header">
          <div className="cert-header-left">
            <span className="cert-header-label">Series</span>
            <span className="cert-header-value">USD · I</span>
          </div>
          <div className="cert-header-mark">
            <span className="cert-header-mark-line" />
            <span className="cert-header-mark-text">Lazy Protocol</span>
            <span className="cert-header-mark-line" />
          </div>
          <div className="cert-header-right">
            <span className="cert-header-label">Issued</span>
            <span className="cert-header-value">{issuedDate}</span>
          </div>
        </header>

        <div className="cert-title-block">
          <p className="cert-eyebrow">Certificate of Deposit</p>
          <h3 className="cert-title">
            <span className="cert-title-prefix">lazy</span>
            <span className="cert-title-mark">USD</span>
          </h3>
          <p className="cert-promise">
            A delta-neutral basis trade on Ethereum. The bearer of this position
            receives compounding yield denominated in USDC, payable continuously,
            redeemable within seven days of notice.
          </p>

          <div className="cert-seal" aria-hidden>
            <svg viewBox="0 0 120 120" className="cert-seal-svg">
              <defs>
                <path id="cert-seal-path" d="M 60,60 m -42,0 a 42,42 0 1,1 84,0 a 42,42 0 1,1 -84,0" />
              </defs>
              <circle cx="60" cy="60" r="54" className="cert-seal-ring-outer" />
              <circle cx="60" cy="60" r="46" className="cert-seal-ring-inner" />
              <text className="cert-seal-text">
                <textPath href="#cert-seal-path" startOffset="0">
                  PATIENT CAPITAL · REWARDED · PATIENT CAPITAL · REWARDED ·
                </textPath>
              </text>
              <text x="60" y="56" className="cert-seal-mono">L</text>
              <text x="60" y="74" className="cert-seal-est">EST. MMXXVI</text>
            </svg>
          </div>
        </div>

        <div className="cert-statement">
          <div className="cert-statement-header">
            <span className="cert-statement-eyebrow">Issued to bearer</span>
            {address && (
              <span className="cert-statement-bearer">
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
            )}
          </div>

          <table className="cert-ledger">
            <tbody>
              <tr>
                <th scope="row">
                  <span className="cert-ledger-num">i.</span>
                  <span className="cert-ledger-key">Principal value</span>
                </th>
                <td>
                  <span className="cert-ledger-amount">${formatUsdc(usdcValue)}</span>
                  <span className="cert-ledger-unit">USDC</span>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <span className="cert-ledger-num">ii.</span>
                  <span className="cert-ledger-key">Shares of record</span>
                </th>
                <td>
                  <span className="cert-ledger-amount">
                    {shares.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="cert-ledger-unit">lazyUSD</span>
                </td>
              </tr>
              <tr className="cert-ledger-emphasis">
                <th scope="row">
                  <span className="cert-ledger-num">iii.</span>
                  <span className="cert-ledger-key">Yield accrued</span>
                </th>
                <td>
                  {totalYield > 0 ? (
                    <>
                      <span className="cert-ledger-amount cert-ledger-amount-positive">
                        +${totalYield.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <span className="cert-ledger-percent">+{profitLossPercent.toFixed(2)}%</span>
                    </>
                  ) : (
                    <span className="cert-ledger-amount cert-ledger-amount-muted">—</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          {realizedApr !== null && daysHeld !== null && daysHeld >= 1 && (
            <div className="cert-affirmation">
              <span className="cert-affirmation-flourish" aria-hidden>§</span>
              <span className="cert-affirmation-body">
                Realized at <em className="cert-affirmation-rate">{realizedApr.toFixed(2)}%</em> over{' '}
                <em>{Math.floor(daysHeld)}</em> {Math.floor(daysHeld) === 1 ? 'day' : 'days'} of patience.
              </span>
            </div>
          )}
        </div>

        <p className="cert-finepr">
          Withdrawals settle within seven days of notice. Yield is delta-neutral and
          computed from the share price of record. Past performance does not constitute a guarantee.
        </p>
      </article>
    </div>
  );
}
