import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Copy, Check } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

const MULTISIG_ADDRESS = '0x0FBCe7F3678467f7F7313fcB2C9D1603431Ad666';
const OPERATOR_ADDRESS = '0xF466ad87c98f50473Cf4Fe32CdF8db652F9E36D6';

const EXPLORERS = {
  multisig: {
    etherscan: `https://etherscan.io/address/${MULTISIG_ADDRESS}`,
    hyperevm: `https://hyperevmscan.io/address/${MULTISIG_ADDRESS}`,
    lighter: `https://app.lighter.xyz/explorer/accounts/${MULTISIG_ADDRESS}`,
    pendle: `https://app.pendle.finance/trade/portfolio/${MULTISIG_ADDRESS}`,
  },
  operator: {
    hypurrscan: `https://hypurrscan.io/address/${OPERATOR_ADDRESS}`,
    hyperevm: `https://hyperevmscan.io/address/${OPERATOR_ADDRESS}`,
  },
};

type Explorer = { name: string; href: string };
const MULTISIG_EXPLORERS: Explorer[] = [
  { name: 'Etherscan', href: EXPLORERS.multisig.etherscan },
  { name: 'HyperEVM', href: EXPLORERS.multisig.hyperevm },
  { name: 'Lighter', href: EXPLORERS.multisig.lighter },
  { name: 'Pendle', href: EXPLORERS.multisig.pendle },
];
const OPERATOR_EXPLORERS: Explorer[] = [
  { name: 'Hypurrscan', href: EXPLORERS.operator.hypurrscan },
  { name: 'HyperEVM', href: EXPLORERS.operator.hyperevm },
];

// ---------- types ----------

type NavLine = { label: string; value: number };
type Exposure = {
  totalHoldings?: number;
  totalShort?: number;
  spot?: number;
  totalSol?: number;
  netExposure?: number;
  currentPrice?: number;
  totalValue?: number;
};
type BackingData = {
  publishedAt: string;
  vault: {
    address: string;
    sharePrice: number;
    totalShares: number;
    totalAssets: number;
    accumulatedYield: number;
  };
  cumulativeFlows: { deposited: number; withdrawn: number };
  nav: { total: number; breakdown: NavLine[] };
  exposures: Record<string, Exposure | undefined>;
  venues: {
    lighter?: { collateral: number; unrealizedPnl: number; positionCount: number };
    lighterOperator?: { equity: number; unrealizedPnl: number; positionCount: number };
    hyperliquid?: {
      equity: number;
      collateral: number;
      unrealizedPnl: number;
      positionCount: number;
    };
    derive?: {
      usdcBalance: number;
      portfolioValue: number;
      shortCount: number;
      longCount: number;
    };
    rysk?: { usdcCollateral: number; usdt0Collateral: number; vaultCount: number };
    hyperLend?: { totalCollateralUsd: number; totalDebtUsd: number; netValueUsd: number };
    pendle?: { totalUsd?: number; positionCount: number };
  };
  optionBook: {
    currentMtm: number;
    deriveShortMtmCost: number;
    ryskLongMark: number;
    upperBoundIfAllOtm: number;
    deriveShortCount: number;
    deriveLongCount: number;
    ryskUnmatchedLegs: number;
    expiries: string[];
  };
};

// ---------- helpers ----------

function fmtUsd(n: number | undefined, opts?: { sign?: boolean; decimals?: number }) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '–';
  const decimals = opts?.decimals ?? 2;
  const sign = n < 0 ? '−' : opts?.sign && n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtNum(n: number | undefined, decimals = 2) {
  if (n === undefined || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtRelativeTime(iso: string): { label: string; stale: boolean } {
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  const stale = diffSec > 48 * 3600;
  if (diffSec < 60) return { label: 'just now', stale };
  if (diffSec < 3600)
    return { label: `${Math.floor(diffSec / 60)} minute${Math.floor(diffSec / 60) === 1 ? '' : 's'} ago`, stale };
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    return { label: `${h} hour${h === 1 ? '' : 's'} ago`, stale };
  }
  const d = Math.floor(diffSec / 86400);
  return { label: `${d} day${d === 1 ? '' : 's'} ago`, stale };
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtExpiry(iso: string) {
  try {
    const d = new Date(iso + 'T08:00:00Z');
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

// ---------- copy button ----------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="bkx-copy"
      aria-label="Copy address"
      title="Copy"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// ---------- section frame ----------

function Section({
  num,
  tag,
  title,
  children,
}: {
  num: string;
  tag: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bkx-section">
      <div className="bkx-section-head">
        <div className="bkx-section-gutter">
          <div className="bkx-section-num">{num}</div>
          <div className="bkx-section-tag">{tag}</div>
        </div>
        <h2 className="bkx-section-title">{title}</h2>
      </div>
      <div className="bkx-section-body">{children}</div>
    </section>
  );
}

// ---------- main ----------

export function Backing() {
  const [data, setData] = useState<BackingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePageMeta({
    title: 'Lazy Backing · What backs your lazyUSD.',
    description:
      'Every position the vault holds. NAV, exposure by asset, venue summaries, the option book. Refreshed when the operator publishes a snapshot.',
    canonical: '/backing',
  });

  useEffect(() => {
    let cancelled = false;
    const REMOTE_BACKING_URL =
      'https://raw.githubusercontent.com/Lazy-Protocol/lazy/main/frontend/public/backing.json';
    const url = import.meta.env.DEV ? '/backing.json' : REMOTE_BACKING_URL;
    fetch(url, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setError('Backing snapshot not yet published.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stamp = useMemo(() => {
    if (!data) return null;
    return fmtRelativeTime(data.publishedAt);
  }, [data]);

  return (
    <div className="bkx">
      {/* Hero */}
      <header className="bkx-hero">
        <div className="container">
          <div className="bkx-mark">
            <span className="bkx-mark-dot" aria-hidden />
            <span>Statement of backing</span>
          </div>
          <h1 className="bkx-title">
            What backs<br />
            your <em>lazyUSD.</em>
          </h1>
          <p className="bkx-dek">
            Every position the vault holds. Every venue it touches. Refreshed when the operator
            publishes a snapshot. This is the receipt.
          </p>
          <div className="bkx-stamp">
            <span className="bkx-stamp-label">Last published</span>
            <span className="bkx-stamp-value">
              {data ? fmtDate(data.publishedAt) : '–'}{' '}
              {stamp && <span className="bkx-stamp-rel">({stamp.label})</span>}
            </span>
            {stamp?.stale && (
              <span className="bkx-stamp-stale">Older than 48h. Next snapshot pending.</span>
            )}
          </div>
        </div>
      </header>

      <div className="container bkx-body">
        {/* I. Where capital lives */}
        <Section num="I" tag="Custody" title="Where capital lives.">
          <div className="bkx-wallets">
            <WalletCard
              role="Primary"
              roleHint="Holds the book"
              name="Treasury multisig"
              description="Multi-signature Safe holding every position the vault carries. Movements require approval from multiple signers."
              address={MULTISIG_ADDRESS}
              explorers={MULTISIG_EXPLORERS}
            />
            <WalletCard
              role="Operator"
              roleHint="Executes on venues"
              name="Operator wallet"
              description="Single-key wallet used on venues without Safe support. Mirrors the same on-chain visibility; trades route here, never the underlying capital."
              address={OPERATOR_ADDRESS}
              explorers={OPERATOR_EXPLORERS}
            />
          </div>
        </Section>

        {error && (
          <div className="bkx-empty">
            <p>{error}</p>
            <p className="bkx-empty-sub">
              The operator publishes a fresh snapshot of vault holdings periodically. Check back
              shortly.
            </p>
          </div>
        )}

        {!error && (
          <>
            {/* II. Vault state */}
            <Section num="II" tag="State" title="Vault state.">
              <div className="bkx-state-grid">
                <Figure
                  label="Total NAV"
                  value={data ? fmtUsd(data.nav.total, { decimals: 0 }) : null}
                  emphasis
                />
                <Figure
                  label="lazyUSD price"
                  value={data ? `$${fmtNum(data.vault.sharePrice, 6)}` : null}
                />
                <Figure
                  label="lazyUSD outstanding"
                  value={data ? fmtNum(data.vault.totalShares, 2) : null}
                />
                <Figure
                  label="Accumulated yield"
                  value={data ? fmtUsd(data.vault.accumulatedYield, { decimals: 0 }) : null}
                />
              </div>

              <div className="bkx-state-flows">
                <FlowFig
                  label="Cumulative deposited"
                  value={data ? fmtUsd(data.cumulativeFlows.deposited, { decimals: 0 }) : null}
                />
                <FlowFig
                  label="Cumulative withdrawn"
                  value={data ? fmtUsd(data.cumulativeFlows.withdrawn, { decimals: 0 }) : null}
                />
                <FlowFig
                  label="Net capital deployed"
                  value={
                    data
                      ? fmtUsd(
                          data.cumulativeFlows.deposited - data.cumulativeFlows.withdrawn,
                          { decimals: 0 }
                        )
                      : null
                  }
                />
              </div>
            </Section>

            {/* III. NAV breakdown */}
            <Section num="III" tag="Composition" title="NAV breakdown.">
              <NavRegister data={data} />
              <p className="bkx-footnote">
                Total NAV reflects everything except still-open option-book mark-to-market, which
                is shown separately in §VII.
              </p>
            </Section>

            {/* IV. Per-asset exposure */}
            <Section num="IV" tag="Exposure" title="Per-asset exposure.">
              <p className="bkx-section-intro">
                The vault is constructed to be delta-neutral. Spot holdings are paired with short
                perps so that price moves cancel out. Residual net exposure shown for each asset
                is the dust the hedge cannot cleanly cover.
              </p>
              <div className="bkx-exposures">
                <ExposureRow symbol="HYPE" data={data?.exposures.hype} />
                <ExposureRow symbol="LIT" data={data?.exposures.lit} />
                <ExposureRow symbol="ETH" data={data?.exposures.eth} />
                <ExposureRow symbol="BTC" data={data?.exposures.btc} kind="perp" />
              </div>
            </Section>

            {/* V. Venues */}
            <Section num="V" tag="Venues" title="What sits where.">
              <div className="bkx-venues">
                <VenueRow
                  name="Lighter"
                  metric="Collateral"
                  value={data?.venues.lighter?.collateral}
                  meta={
                    data
                      ? `${data.venues.lighter?.positionCount ?? 0} positions · unrealised ${fmtUsd(data.venues.lighter?.unrealizedPnl, { sign: true, decimals: 0 })}`
                      : null
                  }
                  href={EXPLORERS.multisig.lighter}
                />
                <VenueRow
                  name="Lighter (operator)"
                  metric="Equity"
                  value={data?.venues.lighterOperator?.equity}
                  meta={
                    data
                      ? `${data.venues.lighterOperator?.positionCount ?? 0} positions · standalone, not delta-neutral`
                      : null
                  }
                />
                <VenueRow
                  name="Hyperliquid"
                  metric="Equity"
                  value={data?.venues.hyperliquid?.equity}
                  meta={
                    data
                      ? `${data.venues.hyperliquid?.positionCount ?? 0} short perps · collateral ${fmtUsd(data.venues.hyperliquid?.collateral, { decimals: 0 })}`
                      : null
                  }
                />
                <VenueRow
                  name="Derive"
                  metric="Portfolio value"
                  value={data?.venues.derive?.portfolioValue}
                  meta={
                    data
                      ? `USDC balance ${fmtUsd(data.venues.derive?.usdcBalance, { decimals: 0 })} · ${data.venues.derive?.shortCount ?? 0} shorts`
                      : null
                  }
                />
                <VenueRow
                  name="Rysk"
                  metric="Stable collateral"
                  value={
                    data
                      ? (data.venues.rysk?.usdcCollateral || 0) +
                        (data.venues.rysk?.usdt0Collateral || 0)
                      : undefined
                  }
                  meta={data ? `${data.venues.rysk?.vaultCount ?? 0} option vaults` : null}
                />
                <VenueRow
                  name="HyperLend"
                  metric="Net value"
                  value={data?.venues.hyperLend?.netValueUsd}
                  meta={
                    data
                      ? `Collateral ${fmtUsd(data.venues.hyperLend?.totalCollateralUsd, { decimals: 0 })} · debt ${fmtUsd(data.venues.hyperLend?.totalDebtUsd, { decimals: 0 })}`
                      : null
                  }
                />
                {data && (data.venues.pendle?.totalUsd ?? 0) > 0 && (
                  <VenueRow
                    name="Pendle"
                    metric="PT value"
                    value={data.venues.pendle?.totalUsd}
                    meta={`${data.venues.pendle?.positionCount ?? 0} positions`}
                    href={EXPLORERS.multisig.pendle}
                  />
                )}
              </div>
            </Section>

            {/* VI. Option book – distinctive section */}
            <Section num="VI" tag="In flight" title="Option book.">
              <OptionBook data={data} />
            </Section>

            {/* VII. How your capital works */}
            <Section num="VII" tag="Strategies" title="How your capital works.">
              <p className="bkx-section-intro">
                The vault runs three strategies in parallel. None depend on the market going up.
                Each is delta-neutral or fully hedged. The numbers above are these strategies,
                marked to market.
              </p>

              <div className="bkx-strats">
                <StrategyRow
                  roman="i."
                  name="Basis yield"
                  body="Spot exposure paired with a short perpetual of the same size. The perp pays funding while it is held. That funding stream is the yield. See HYPE and LIT in §IV, plus the Hyperliquid and Lighter equity rows in §V."
                />
                <StrategyRow
                  roman="ii."
                  name="Options arbitrage"
                  body="The vault sells options on Derive where implied volatility is rich and buys the same option on Rysk where it is cheap. The spread is the yield, hedged at the moment the trade opens. The Derive and Rysk numbers in §V are this book. The mark-to-market and ceiling in §VI are the book in flight."
                />
                <StrategyRow
                  roman="iii."
                  name="Gamma scalping"
                  body="An options position with a delta hedge that is rehedged as the underlying moves. Each rehedge locks in a fraction of the realised move. The strategy earns the gap between realised and implied volatility, less the cost of the rehedges themselves."
                />
              </div>
            </Section>
          </>
        )}

        {/* Footer */}
        <footer className="bkx-foot">
          <p className="bkx-foot-line">Don't trust. Verify.</p>
          <div className="bkx-foot-ctas">
            <a
              href={EXPLORERS.multisig.etherscan}
              target="_blank"
              rel="noopener noreferrer"
              className="bkx-foot-cta"
            >
              <span>Multisig on Etherscan</span>
              <ArrowUpRight size={14} />
            </a>
            <a
              href={EXPLORERS.operator.hypurrscan}
              target="_blank"
              rel="noopener noreferrer"
              className="bkx-foot-cta"
            >
              <span>Operator on Hypurrscan</span>
              <ArrowUpRight size={14} />
            </a>
            <Link to="/docs" className="bkx-foot-cta bkx-foot-cta-ghost">
              <span>Read the docs</span>
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default Backing;

// ---------- subcomponents ----------

function WalletCard({
  role,
  roleHint,
  name,
  description,
  address,
  explorers,
}: {
  role: string;
  roleHint: string;
  name: string;
  description: string;
  address: string;
  explorers: Explorer[];
}) {
  return (
    <article className="bkx-wallet">
      <header className="bkx-wallet-head">
        <div className="bkx-wallet-role-row">
          <span className="bkx-wallet-role">{role}</span>
          <span className="bkx-wallet-role-hint">{roleHint}</span>
        </div>
        <h3 className="bkx-wallet-name">{name}</h3>
        <p className="bkx-wallet-desc">{description}</p>
      </header>

      <div className="bkx-wallet-addr-block">
        <div className="bkx-wallet-addr-label">Address</div>
        <div className="bkx-wallet-addr-row">
          <code className="bkx-wallet-addr-code">
            <span className="bkx-wallet-addr-prefix">{address.slice(0, 6)}</span>
            <span>{address.slice(6, -4)}</span>
            <span className="bkx-wallet-addr-prefix">{address.slice(-4)}</span>
          </code>
          <CopyButton text={address} />
        </div>
      </div>

      <div className="bkx-wallet-manifest">
        <div className="bkx-wallet-manifest-label">Verify on</div>
        <ul className="bkx-wallet-manifest-list">
          {explorers.map((ex) => (
            <li key={ex.name}>
              <a href={ex.href} target="_blank" rel="noopener noreferrer">
                <span>{ex.name}</span>
                <ArrowUpRight size={12} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string | null;
  emphasis?: boolean;
}) {
  return (
    <div className={emphasis ? 'bkx-fig bkx-fig-hero' : 'bkx-fig'}>
      <div className="bkx-fig-label">{label}</div>
      <div className="bkx-fig-value">{value ?? <span className="bkx-skel" />}</div>
    </div>
  );
}

function FlowFig({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bkx-flow">
      <span className="bkx-flow-label">{label}</span>
      <span className="bkx-flow-value">{value ?? <span className="bkx-skel-sm" />}</span>
    </div>
  );
}

function NavRegister({ data }: { data: BackingData | null }) {
  if (!data) {
    return (
      <div className="bkx-register">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="bkx-nav-row bkx-nav-row-skel">
            <span className="bkx-skel-sm" style={{ width: '40%' }} />
            <span className="bkx-skel-sm" style={{ width: '15%' }} />
          </div>
        ))}
      </div>
    );
  }
  const maxAbs = Math.max(...data.nav.breakdown.map((b) => Math.abs(b.value)));
  return (
    <div className="bkx-register">
      {data.nav.breakdown.map((line) => {
        const pct = maxAbs > 0 ? (Math.abs(line.value) / maxAbs) * 100 : 0;
        const negative = line.value < 0;
        return (
          <div key={line.label} className="bkx-nav-row">
            <div className="bkx-nav-label">{line.label}</div>
            <div className="bkx-nav-bar-cell">
              <div
                className={negative ? 'bkx-nav-bar bkx-nav-bar-neg' : 'bkx-nav-bar'}
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            <div className={negative ? 'bkx-nav-val bkx-nav-val-neg' : 'bkx-nav-val'}>
              {fmtUsd(line.value, { decimals: 0 })}
            </div>
          </div>
        );
      })}
      <div className="bkx-nav-total">
        <span className="bkx-nav-total-label">Total</span>
        <span className="bkx-nav-total-value">
          {fmtUsd(data.nav.total, { decimals: 0 })}
        </span>
      </div>
    </div>
  );
}

function ExposureRow({
  symbol,
  data,
  kind,
}: {
  symbol: string;
  data?: Exposure;
  kind?: 'perp';
}) {
  const holdings = data?.totalHoldings ?? data?.spot ?? data?.totalSol;
  const hasShort = data?.totalShort !== undefined && data?.totalShort !== null;
  const net = data?.netExposure;
  const price = data?.currentPrice;
  const total = data?.totalValue;

  // hedge ratio bar
  let hedgePct = 100;
  if (hasShort && holdings && holdings > 0 && data?.totalShort) {
    hedgePct = Math.min(100, Math.max(0, (data.totalShort / holdings) * 100));
  }
  if (kind === 'perp') hedgePct = 100;

  return (
    <div className="bkx-exp">
      <div className="bkx-exp-head">
        <div className="bkx-exp-symbol">{symbol}</div>
        <div className="bkx-exp-hedge">
          <div className="bkx-exp-hedge-track">
            <div className="bkx-exp-hedge-fill" style={{ width: `${hedgePct}%` }} />
          </div>
          <span className="bkx-exp-hedge-pct">
            {data ? `${hedgePct.toFixed(0)}% hedged` : '–'}
          </span>
        </div>
      </div>
      <div className="bkx-exp-row">
        <ExpStat label={kind === 'perp' ? 'Spot' : 'Holdings'} value={fmtNum(holdings, 4)} />
        <ExpStat label="Short" value={hasShort ? fmtNum(data?.totalShort, 4) : '–'} />
        <ExpStat label="Net" value={fmtNum(net, 4)} />
        <ExpStat label="Price" value={price ? `$${fmtNum(price, price < 10 ? 4 : 2)}` : '–'} />
        <ExpStat
          label="Value"
          value={fmtUsd(total, { decimals: 0 })}
          mono
        />
      </div>
    </div>
  );
}

function ExpStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bkx-exp-stat">
      <div className="bkx-exp-stat-label">{label}</div>
      <div className={mono ? 'bkx-exp-stat-val bkx-exp-stat-val-emph' : 'bkx-exp-stat-val'}>
        {value}
      </div>
    </div>
  );
}

function VenueRow({
  name,
  metric,
  value,
  meta,
  href,
}: {
  name: string;
  metric: string;
  value: number | undefined;
  meta: string | null;
  href?: string;
}) {
  const content = (
    <>
      <div className="bkx-venue-name">{name}</div>
      <div className="bkx-venue-metric-block">
        <div className="bkx-venue-metric-label">{metric}</div>
        <div className="bkx-venue-metric-value">{fmtUsd(value, { decimals: 0 })}</div>
      </div>
      <div className="bkx-venue-meta">{meta ?? <span className="bkx-skel-sm" />}</div>
      {href && (
        <div className="bkx-venue-link">
          <ArrowUpRight size={14} />
        </div>
      )}
    </>
  );
  if (href) {
    return (
      <a className="bkx-venue bkx-venue-link-row" href={href} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
    );
  }
  return <div className="bkx-venue">{content}</div>;
}

function OptionBook({ data }: { data: BackingData | null }) {
  if (!data) {
    return (
      <div className="bkx-ob">
        <div className="bkx-skel-block" />
      </div>
    );
  }
  const ob = data.optionBook;
  const range = ob.upperBoundIfAllOtm - ob.currentMtm;
  // scale: place current at left, ceiling at right, on a normalized 0..1
  const zeroPos =
    range > 0 ? Math.max(0, Math.min(1, (0 - ob.currentMtm) / range)) : 0.5;
  const currentPos = 0;
  const ceilingPos = 1;

  return (
    <div className="bkx-ob">
      <p className="bkx-section-intro">
        The vault sells rich-IV options on Derive and buys cheap-IV options on Rysk. Until each
        leg expires, the position carries an unrealised mark-to-market. The arc below is what
        that book can still deliver before the next round of expiries.
      </p>

      <div className="bkx-ob-range">
        <div className="bkx-ob-range-track">
          <div
            className="bkx-ob-zero"
            style={{ left: `${zeroPos * 100}%` }}
            aria-hidden
          />
          <div
            className="bkx-ob-current"
            style={{ left: `${currentPos * 100}%` }}
            aria-label="Current mark-to-market"
          />
          <div
            className="bkx-ob-ceiling"
            style={{ left: `${ceilingPos * 100}%` }}
            aria-label="Theoretical ceiling"
          />
        </div>
        <div className="bkx-ob-range-axis">
          <div className="bkx-ob-axis-current" style={{ left: `${currentPos * 100}%` }}>
            <div className="bkx-ob-axis-label">Current MTM</div>
            <div className="bkx-ob-axis-val">{fmtUsd(ob.currentMtm, { decimals: 0 })}</div>
          </div>
          <div className="bkx-ob-axis-ceiling" style={{ left: `${ceilingPos * 100}%` }}>
            <div className="bkx-ob-axis-label">Theoretical ceiling</div>
            <div className="bkx-ob-axis-val">{fmtUsd(ob.upperBoundIfAllOtm, { decimals: 0 })}</div>
          </div>
          <div className="bkx-ob-axis-zero" style={{ left: `${zeroPos * 100}%` }}>
            <div className="bkx-ob-axis-label">Zero</div>
          </div>
        </div>
      </div>

      <p className="bkx-ob-caveat">
        The ceiling is unreachable in practice. The perp hedges that keep the book delta-neutral
        bleed continuously between now and expiry, so the realised number will land below the
        ceiling. Treat it as the upper bound of a range, not a target.
      </p>

      <div className="bkx-ob-detail">
        <div className="bkx-ob-d">
          <div className="bkx-ob-d-label">Derive short MTM cost</div>
          <div className="bkx-ob-d-val">{fmtUsd(ob.deriveShortMtmCost, { decimals: 0 })}</div>
          <div className="bkx-ob-d-note">
            What we would pay if every short settled at current mark right now
          </div>
        </div>
        <div className="bkx-ob-d">
          <div className="bkx-ob-d-label">Rysk long mark</div>
          <div className="bkx-ob-d-val">
            {fmtUsd(ob.ryskLongMark, { sign: true, decimals: 0 })}
          </div>
          <div className="bkx-ob-d-note">
            Credit if every long settled at current mark right now
          </div>
        </div>
        <div className="bkx-ob-d">
          <div className="bkx-ob-d-label">Short positions</div>
          <div className="bkx-ob-d-val">{ob.deriveShortCount}</div>
          <div className="bkx-ob-d-note">Derive (vault sells rich IV here)</div>
        </div>
        <div className="bkx-ob-d">
          <div className="bkx-ob-d-label">Long legs</div>
          <div className="bkx-ob-d-val">{ob.deriveLongCount + ob.ryskUnmatchedLegs}</div>
          <div className="bkx-ob-d-note">
            Rysk longs offsetting the Derive shorts
          </div>
        </div>
      </div>

      <div className="bkx-ob-expiries">
        <div className="bkx-ob-expiries-label">Expiries this cycle</div>
        <div className="bkx-ob-expiries-row">
          {ob.expiries.map((e) => (
            <div key={e} className="bkx-ob-expiry">
              {fmtExpiry(e)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StrategyRow({
  roman,
  name,
  body,
}: {
  roman: string;
  name: string;
  body: string;
}) {
  return (
    <div className="bkx-strat">
      <div className="bkx-strat-label">
        <span className="bkx-strat-num">{roman}</span>
        <span>{name}</span>
      </div>
      <p className="bkx-strat-body">{body}</p>
    </div>
  );
}
