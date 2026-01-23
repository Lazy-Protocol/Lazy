import { useState, useMemo } from 'react';
import { Calculator, TrendingUp, Clock, ChevronDown, ChevronUp, Share2 } from 'lucide-react';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { ShareCard } from './ShareCard';

// Yield categories with APY ranges
const YIELD_CATEGORIES = [
  { id: 'savings', name: 'Traditional Savings', min: 0.5, max: 4, color: 'var(--slate)' },
  { id: 'money-market', name: 'Money Market', min: 4, max: 5, color: 'var(--info-blue)' },
  { id: 'defi-lending', name: 'DeFi Lending', min: 2, max: 6, color: 'var(--alert-amber)' },
  { id: 'delta-neutral', name: 'Delta-Neutral (Lazy)', min: 8, max: 14, color: 'var(--yield-gold)', isLazy: true },
];

const TARGET_YEARS = [2030, 2040, 2050];
const CURRENT_YEAR = 2026;

// Calculate future value with compound interest
function calculateFutureValue(principal: number, apy: number, years: number): number {
  return principal * Math.pow(1 + apy / 100, years);
}

// Format currency
function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${value.toFixed(2)}`;
}

export function TimeMachine() {
  const [amount, setAmount] = useState('1000');
  const [targetYear, setTargetYear] = useState(2040);
  const [showComparison, setShowComparison] = useState(false);
  const [showShareCard, setShowShareCard] = useState(false);
  const { data: protocolStats } = useProtocolStats();

  const parsedAmount = parseFloat(amount) || 0;
  const years = targetYear - CURRENT_YEAR;

  // Get current Lazy APY from protocol stats, fallback to 12%
  const lazyApy = protocolStats?.apr || 12;

  // Calculate projections for all categories
  const projections = useMemo(() => {
    return YIELD_CATEGORIES.map((category) => {
      // Use actual Lazy APY for delta-neutral
      const apy = category.isLazy ? lazyApy : (category.min + category.max) / 2;
      const futureValue = calculateFutureValue(parsedAmount, apy, years);
      const gain = futureValue - parsedAmount;
      const multiplier = parsedAmount > 0 ? futureValue / parsedAmount : 0;

      return {
        ...category,
        apy,
        futureValue,
        gain,
        multiplier,
      };
    });
  }, [parsedAmount, years, lazyApy]);

  // Get Lazy projection
  const lazyProjection = projections.find((p) => p.isLazy)!;

  return (
    <section className="section time-machine-section" id="time-machine">
      <div className="container">
        <div className="section-header">
          <h2 className="section-title">See what patience looks like in {targetYear}.</h2>
          <p className="section-subtitle">Compound interest rewards those who wait.</p>
        </div>

        <div className="time-machine">
          {/* Input Section */}
          <div className="tm-input-section">
            <div className="tm-input-group">
              <label className="tm-label">If I deposit</label>
              <div className="tm-amount-input">
                <span className="tm-currency">$</span>
                <input
                  type="text"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="1,000"
                  className="tm-input"
                />
              </div>
              <div className="tm-presets">
                {[1000, 5000, 10000, 50000].map((preset) => (
                  <button
                    key={preset}
                    className={`tm-preset ${parsedAmount === preset ? 'active' : ''}`}
                    onClick={() => setAmount(preset.toString())}
                  >
                    ${preset.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <div className="tm-input-group">
              <label className="tm-label">By the year</label>
              <div className="tm-year-selector">
                {TARGET_YEARS.map((year) => (
                  <button
                    key={year}
                    className={`tm-year ${targetYear === year ? 'active' : ''}`}
                    onClick={() => setTargetYear(year)}
                  >
                    {year}
                  </button>
                ))}
              </div>
              <p className="tm-years-note">{years} years of compounding</p>
            </div>
          </div>

          {/* Result Section */}
          <div className="tm-result-section">
            <div className="tm-result-card">
              <div className="tm-result-header">
                <Calculator size={20} />
                <span>Your projection with Lazy</span>
              </div>

              <div className="tm-result-value">
                {formatCurrency(lazyProjection.futureValue)}
              </div>

              <div className="tm-result-details">
                <div className="tm-detail">
                  <TrendingUp size={16} />
                  <span>+{formatCurrency(lazyProjection.gain)} gain</span>
                </div>
                <div className="tm-detail">
                  <Clock size={16} />
                  <span>{lazyProjection.multiplier.toFixed(1)}x in {years} years</span>
                </div>
              </div>

              <div className="tm-result-apy">
                Using current {lazyApy.toFixed(1)}% APY
              </div>

              {/* Share Button */}
              <div className="tm-share-buttons">
                <button
                  className="btn btn-primary tm-share-btn"
                  onClick={() => setShowShareCard(true)}
                  style={{ flex: 1 }}
                >
                  <Share2 size={16} />
                  Share Your Projection
                </button>
              </div>
            </div>

            {/* Comparison Toggle */}
            <button
              className="tm-comparison-toggle"
              onClick={() => setShowComparison(!showComparison)}
            >
              {showComparison ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              Compare across yield categories
            </button>

            {/* Comparison Table */}
            {showComparison && (
              <div className="tm-comparison">
                <div className="tm-comparison-header">
                  <span>Strategy</span>
                  <span>APY</span>
                  <span>Value in {targetYear}</span>
                </div>
                {projections.map((projection) => (
                  <div
                    key={projection.id}
                    className={`tm-comparison-row ${projection.isLazy ? 'highlight' : ''}`}
                  >
                    <span className="tm-comparison-name">
                      <span
                        className="tm-comparison-dot"
                        style={{ background: projection.color }}
                      />
                      {projection.name}
                    </span>
                    <span className="tm-comparison-apy">
                      {projection.isLazy
                        ? `${projection.apy.toFixed(1)}%`
                        : `${projection.min}-${projection.max}%`}
                    </span>
                    <span className="tm-comparison-value">
                      {formatCurrency(projection.futureValue)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Disclaimer */}
            <p className="tm-disclaimer">
              Projections use current rates. Yields vary. This isn't a promise — it's math.
            </p>
          </div>
        </div>
      </div>

      {/* Share Card Modal */}
      {showShareCard && (
        <ShareCard
          amount={parsedAmount}
          futureValue={lazyProjection.futureValue}
          targetYear={targetYear}
          years={years}
          apy={lazyApy}
          onClose={() => setShowShareCard(false)}
        />
      )}
    </section>
  );
}
