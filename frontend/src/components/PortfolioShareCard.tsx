import { useRef, useState } from 'react';
import { X, Share2, Download, Check } from 'lucide-react';
import html2canvas from 'html2canvas';

interface PortfolioShareCardProps {
  totalValue: string;
  earnings: string;
  earningsPercent: string;
  holdDays: number;
  onClose: () => void;
}

export function PortfolioShareCard({
  totalValue,
  earnings,
  earningsPercent,
  holdDays,
  onClose,
}: PortfolioShareCardProps) {
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const tweetText = `${totalValue} in patient capital.

+${earnings} earned (${earningsPercent}%) over ${holdDays} days.

Did nothing. Just held.

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
      link.download = `lazy-portfolio.png`;
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

  const cardStyles = {
    card: {
      width: '500px',
      height: '300px',
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
    label: {
      fontSize: '12px',
      fontWeight: 500,
      color: 'rgba(232, 230, 225, 0.5)',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
      marginBottom: '8px',
    },
    value: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '42px',
      fontWeight: 700,
      color: '#C4A052',
      lineHeight: 1,
      marginBottom: '16px',
    },
    statsRow: {
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      padding: '10px 20px',
      background: 'rgba(255, 255, 255, 0.05)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: '4px',
      marginBottom: '16px',
    },
    stat: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '13px',
      fontWeight: 500,
      color: '#FAFBFC',
    },
    statGreen: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: '13px',
      fontWeight: 500,
      color: '#22C55E',
    },
    divider: {
      width: '1px',
      height: '16px',
      background: 'rgba(255, 255, 255, 0.2)',
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

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: '560px' }}>
        <div className="modal-header">
          <h3 className="modal-title">Share Your Portfolio</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <p style={{ color: 'var(--slate)', marginBottom: 'var(--space-md)', textAlign: 'center' }}>
          Show what patience looks like.
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-lg)' }}>
          <div ref={shareCardRef} style={cardStyles.card}>
            <div style={cardStyles.grid} />
            <div style={cardStyles.logo}>Lazy</div>
            <div style={cardStyles.content}>
              <div style={cardStyles.label}>Portfolio Value</div>
              <div style={cardStyles.value}>{totalValue}</div>

              <div style={cardStyles.statsRow}>
                <span style={cardStyles.statGreen}>+{earnings}</span>
                <div style={cardStyles.divider} />
                <span style={cardStyles.stat}>{earningsPercent}%</span>
                <div style={cardStyles.divider} />
                <span style={cardStyles.stat}>{holdDays} days</span>
              </div>

              <p style={cardStyles.tagline}>"Did nothing. Just held."</p>
            </div>
            <div style={cardStyles.url}>getlazy.xyz</div>
          </div>
        </div>

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
