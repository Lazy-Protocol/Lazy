import { useRef } from 'react';
import html2canvas from 'html2canvas';

interface ShareCardProps {
  amount: number;
  futureValue: number;
  targetYear: number;
  years: number;
  apy: number;
  onClose: () => void;
}

// Calculate savings account value (using 4% average)
const SAVINGS_APY = 4;

function calculateFutureValue(principal: number, apy: number, years: number): number {
  return principal * Math.pow(1 + apy / 100, years);
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function ShareCard({ amount, futureValue, targetYear, years, apy, onClose }: ShareCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const gain = futureValue - amount;
  const percentGain = amount > 0 ? ((gain / amount) * 100) : 0;
  const multiplier = amount > 0 ? futureValue / amount : 0;
  const savingsValue = calculateFutureValue(amount, SAVINGS_APY, years);

  // Generate share text (social manager approved)
  const tweetText = `${formatCurrency(futureValue)} by ${targetYear}.

That's what $${amount.toLocaleString()} could become. ${multiplier.toFixed(1)}x. No leverage. No lock-up.

Patience has a number.

getlazy.xyz/time-machine?utm_source=share&utm_medium=twitter #PatientCapital`;

  const handleDownload = async () => {
    if (!cardRef.current) return;

    try {
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: null,
      });

      const link = document.createElement('a');
      link.download = `lazy-projection-${targetYear}.png`;
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
  };

  // Designer-specified styles (inline for html2canvas compatibility)
  const styles = {
    card: {
      width: '600px',
      height: '314px',
      background: '#1a2332',
      position: 'relative' as const,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflow: 'hidden',
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
      top: '24px',
      left: '32px',
      fontSize: '18px',
      fontWeight: 700,
      color: '#FAFBFC',
    },
    content: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      padding: '24px 32px',
      textAlign: 'center' as const,
    },
    context: {
      fontSize: '14px',
      fontWeight: 400,
      color: 'rgba(232, 230, 225, 0.7)',
      marginBottom: '8px',
    },
    heroValue: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '48px',
      fontWeight: 700,
      color: '#C4A052',
      lineHeight: 1,
    },
    underline: {
      width: '80px',
      height: '2px',
      background: '#C4A052',
      marginTop: '12px',
      marginBottom: '8px',
    },
    year: {
      fontSize: '16px',
      fontWeight: 500,
      color: 'rgba(232, 230, 225, 0.6)',
      marginBottom: '16px',
    },
    statsRow: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      padding: '8px 20px',
      background: 'rgba(255, 255, 255, 0.05)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: '4px',
      marginBottom: '16px',
    },
    statValue: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '12px',
      fontWeight: 500,
      color: '#FAFBFC',
    },
    statDivider: {
      width: '1px',
      height: '14px',
      background: 'rgba(255, 255, 255, 0.2)',
    },
    comparison: {
      display: 'flex',
      alignItems: 'center',
      gap: '24px',
      marginBottom: '12px',
    },
    compareItem: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      gap: '2px',
    },
    compareLabel: {
      fontSize: '10px',
      fontWeight: 500,
      color: 'rgba(232, 230, 225, 0.5)',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
    },
    compareValue: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '14px',
      fontWeight: 600,
      color: 'rgba(232, 230, 225, 0.7)',
    },
    compareValueHighlight: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '14px',
      fontWeight: 600,
      color: '#C4A052',
    },
    compareVs: {
      fontSize: '10px',
      fontWeight: 500,
      color: 'rgba(232, 230, 225, 0.3)',
    },
    tagline: {
      fontSize: '13px',
      fontWeight: 500,
      fontStyle: 'italic' as const,
      color: 'rgba(232, 230, 225, 0.5)',
    },
    url: {
      position: 'absolute' as const,
      bottom: '20px',
      right: '28px',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '11px',
      fontWeight: 400,
      color: 'rgba(232, 230, 225, 0.4)',
    },
  };

  return (
    <div className="share-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="share-modal">
        <div className="share-modal-header">
          <h3>Your Shareable Card</h3>
          <button className="share-modal-close" onClick={onClose}>×</button>
        </div>

        {/* The Card - Designer Spec: 1200x628, scaled down for preview */}
        <div className="share-card-wrapper">
          <div ref={cardRef} style={styles.card}>
            {/* Grid texture */}
            <div style={styles.grid} />

            {/* Logo - top left */}
            <div style={styles.logo}>Lazy</div>

            {/* Content - centered */}
            <div style={styles.content}>
              <p style={styles.context}>
                My ${amount.toLocaleString()} deposit today becomes
              </p>

              <div style={styles.heroValue}>{formatCurrency(futureValue)}</div>
              <div style={styles.underline} />
              <div style={styles.year}>in {targetYear}</div>

              {/* Stats Row */}
              <div style={styles.statsRow}>
                <span style={styles.statValue}>+{percentGain.toFixed(0)}%</span>
                <div style={styles.statDivider} />
                <span style={styles.statValue}>{multiplier.toFixed(1)}x</span>
                <div style={styles.statDivider} />
                <span style={styles.statValue}>{apy.toFixed(1)}% APY</span>
              </div>

              {/* Comparison */}
              <div style={styles.comparison}>
                <div style={styles.compareItem}>
                  <span style={styles.compareLabel}>Lazy</span>
                  <span style={styles.compareValueHighlight}>{formatCurrency(futureValue)}</span>
                </div>
                <span style={styles.compareVs}>vs</span>
                <div style={styles.compareItem}>
                  <span style={styles.compareLabel}>Savings Account</span>
                  <span style={styles.compareValue}>{formatCurrency(savingsValue)}</span>
                </div>
              </div>

              {/* Tagline */}
              <p style={styles.tagline}>"Patience has a number."</p>
            </div>

            {/* URL - bottom right */}
            <div style={styles.url}>getlazy.xyz/time-machine</div>
          </div>
        </div>

        {/* Actions */}
        <div className="share-modal-actions">
          <button className="btn btn-primary share-action-btn" onClick={handleTwitterShare}>
            Share on X
          </button>
          <button className="btn btn-secondary share-action-btn" onClick={handleDownload}>
            Download PNG
          </button>
          <button className="btn btn-secondary share-action-btn" onClick={handleCopy}>
            Copy Text
          </button>
        </div>

        <p className="share-modal-hint">
          Download the card and attach it to your post.
        </p>
      </div>
    </div>
  );
}
