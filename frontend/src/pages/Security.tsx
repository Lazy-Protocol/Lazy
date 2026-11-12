import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

const REPO_BASE = 'https://github.com/Lazy-Protocol/lazy/blob/main';
const HALMOS_URL = 'https://github.com/a16z/halmos';

type Invariant = { id: string; name: string; body: string };

const INVARIANTS: Invariant[] = [
  {
    id: 'I.1',
    name: 'Conservation of Value',
    body:
      'Fulfilling a withdrawal burns escrowed lazyUSD and pays USDC at the vault’s current net asset value.',
  },
  {
    id: 'I.2',
    name: 'Token Escrow Safety',
    body:
      'Withdrawal requests move lazyUSD into escrow. The vault holds those shares until the request is fulfilled or cancelled.',
  },
  {
    id: 'I.3',
    name: 'Universal NAV Application',
    body:
      'The same share-price calculation applies to shares held in wallets and in the withdrawal queue.',
  },
  {
    id: 'I.4',
    name: 'Fee Isolation',
    body:
      'Positive yield can mint fee shares to the treasury. The fee calculation is separate from deposits and withdrawals.',
  },
  {
    id: 'I.5',
    name: 'Withdrawal Queue Liveness',
    body:
      'Requests are processed in queue order. Processing stops when a request is still in cooldown or available liquidity is insufficient.',
  },
];

type Section = { num: string; tag: string; title: React.ReactNode; children: React.ReactNode };

function SectionHead({ num, tag, title }: { num: string; tag: string; title: React.ReactNode }) {
  return (
    <header className="sec-section-head">
      <div className="sec-section-gutter">
        <span className="sec-section-num">{num}</span>
        <span className="sec-section-tag">{tag}</span>
      </div>
      <h2 className="sec-section-title">{title}</h2>
    </header>
  );
}

function Section({ num, tag, title, children }: Section) {
  return (
    <section className="sec-section">
      <SectionHead num={num} tag={tag} title={title} />
      <div className="sec-section-body">{children}</div>
    </section>
  );
}

export function Security() {
  usePageMeta({
    title: 'Lazy Security · How we check the vault.',
    description:
      'How Lazy uses OpenZeppelin components, Halmos symbolic execution, and invariant tests to check vault accounting and withdrawals.',
    canonical: '/security',
  });

  return (
    <div className="sec">
      <div className="container sec-page">
        {/* Hero */}
        <header className="sec-hero">
          <div className="sec-mark">
            <span className="sec-mark-dot" aria-hidden />
            <span>Lazy</span>
            <span className="sec-mark-sep" aria-hidden>·</span>
            <span>Statement on security</span>
          </div>

          <h1 className="sec-title">
            How we<br />
            <em>check it.</em>
          </h1>

          <p className="sec-dek">
            Lazy uses Halmos symbolic execution and invariant tests to check its accounting
            and withdrawal logic. The test source is public. No third-party security audit
            has been commissioned.
          </p>

          <div className="sec-rule" aria-hidden />
        </header>

        {/* §01 Thesis */}
        <Section num="§01" tag="Thesis" title={<>What we chose, <em>and why.</em></>}>
          <p>
            The checks focus on how shares are issued, how withdrawals are escrowed and paid,
            and how yield and fees affect net asset value.
          </p>
          <p>
            Each check has a defined setup, range of inputs, and set of assumptions. A passing
            check supports the property it tests. Missing properties and paths outside the
            model still need review.
          </p>
        </Section>

        {/* §02 Invariants */}
        <Section num="§02" tag="Invariants" title={<>Five vault <em>invariants.</em></>}>
          <p className="sec-section-intro">
            These are properties the vault's test suite is designed to check. The source
            shows the setup and assumptions for each test.
          </p>

          <ol className="sec-register">
            {INVARIANTS.map((inv) => (
              <li key={inv.id} className="sec-inv">
                <div className="sec-inv-id">{inv.id}</div>
                <div className="sec-inv-content">
                  <div className="sec-inv-name">{inv.name}</div>
                  <p className="sec-inv-body">{inv.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="sec-sources">
            <span className="sec-sources-label">Source</span>
            <a
              className="sec-source-link"
              href={`${REPO_BASE}/test/formal/HalmosChecks.t.sol`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>HalmosChecks.t.sol</span>
              <ArrowUpRight size={12} />
            </a>
            <a
              className="sec-source-link"
              href={`${REPO_BASE}/test/invariants/VaultInvariants.t.sol`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>VaultInvariants.t.sol</span>
              <ArrowUpRight size={12} />
            </a>
            <a
              className="sec-source-link"
              href={`${REPO_BASE}/test/formal/FormalVerification.t.sol`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>FormalVerification.t.sol</span>
              <ArrowUpRight size={12} />
            </a>
          </div>
        </Section>

        {/* §03 Halmos */}
        <Section num="§03" tag="Method" title={<>Halmos, in <em>plain English.</em></>}>
          <p>
            Halmos represents inputs symbolically and explores the execution paths reached by
            a test. That lets a single check cover a range of inputs within the model.
          </p>
          <p>
            A result depends on the test setup, assumptions, and paths explored. The published
            sources make those boundaries visible.
          </p>
          <p>
            Venue behaviour, operator decisions, and market losses sit outside these contract
            checks. Those risks are described below and on the docs page.
          </p>

          <a
            className="sec-link"
            href={HALMOS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>Halmos · a16z/halmos</span>
            <ArrowUpRight size={12} />
          </a>
        </Section>

        {/* §04 Contract components */}
        <Section num="§04" tag="Foundation" title={<>OpenZeppelin <em>components.</em></>}>
          <p>
            Lazy uses OpenZeppelin's ERC20, SafeERC20, ReentrancyGuard, and Math libraries.
            Share accounting, yield reporting, and the withdrawal queue are implemented in
            Lazy's own contract.
          </p>
        </Section>

        {/* §05 Honest disclosures */}
        <Section num="§05" tag="Disclosure" title={<>What is <em>not covered.</em></>}>
          <div className="sec-plate">
            <div className="sec-plate-head">
              <span>Memo</span>
              <span className="sec-plate-sep" aria-hidden>·</span>
              <span>Residual risk</span>
            </div>
            <p>
              No third-party security audit has been commissioned. Symbolic execution and
              invariant tests cover the properties and scenarios specified in the test suite.
            </p>
            <p>
              The vault is semi-custodial. Multisig operators must return capital deployed in
              active positions to fulfill withdrawals. Operator failure to do so is a residual
              trust that no formal property can remove.
            </p>
            <p>
              Smart contract risk in the venues the vault uses, Hyperliquid, Lighter, Derive,
              Pendle, Rysk, and HyperLend, sits outside Lazy's invariants. A failure at any of
              those venues can affect the value of lazyUSD.
            </p>
            <p>
              Market risk on the underlying strategies remains. Funding rates can go negative.
              Realised volatility can underperform implied. None of the invariants above protect
              against losses generated by the strategies themselves.
            </p>
          </div>
        </Section>

        {/* Close */}
        <footer className="sec-foot">
          <p className="sec-foot-line">Don't trust. Verify.</p>
          <div className="sec-foot-ctas">
            <Link to="/docs" className="sec-foot-cta">
              <span>Read the docs</span>
              <ArrowUpRight size={14} />
            </Link>
            <Link to="/backing" className="sec-foot-cta sec-foot-cta-ghost">
              <span>View backing</span>
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default Security;
