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
      'USDC only exits the vault when lazyUSD is burned at the current net asset value. There is no path by which USDC can leave the vault without a corresponding burn.',
  },
  {
    id: 'I.2',
    name: 'Token Escrow Safety',
    body:
      'lazyUSD held in the withdrawal queue is locked. It cannot be double-spent, transferred, or re-redeemed. Each unit can only be redeemed once.',
  },
  {
    id: 'I.3',
    name: 'Universal NAV Application',
    body:
      'The per-token NAV applies uniformly. No depositor, including those in the queue, receives a different price for the same block.',
  },
  {
    id: 'I.4',
    name: 'Fee Isolation',
    body:
      'Performance fees are taken only on positive yield, and only via newly-minted lazyUSD. Fees never touch principal, and they are not charged on losing periods.',
  },
  {
    id: 'I.5',
    name: 'Withdrawal Queue Liveness',
    body:
      'Withdrawal requests are fulfilled in first-in-first-out order. The queue degrades gracefully under partial liquidity and never reverts.',
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
    title: 'Lazy Security · How we prove it.',
    description:
      'Lazy was not audited by a third-party security firm. Instead the vault is built on battle-tested ERC-4626 contracts and its critical properties are proven mathematically using Halmos symbolic execution.',
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
            <em>prove it.</em>
          </h1>

          <p className="sec-dek">
            Lazy was not audited by a third-party security firm. Instead, the vault is built on
            battle-tested ERC-4626 contracts shipped by Yearn and others, and its critical
            properties are proven mathematically using Halmos symbolic execution. The artifacts
            are public.
          </p>

          <div className="sec-rule" aria-hidden />
        </header>

        {/* §01 Thesis */}
        <Section num="§01" tag="Thesis" title={<>What we chose, <em>and why.</em></>}>
          <p>
            Lazy's security posture is built on two ideas. The first is that mathematical proof,
            run against the contract itself, gives stronger guarantees than a human auditor
            reading the code. A proof under symbolic execution explores every possible input
            within a property's domain. An audit can only check what the auditor thought to
            check. The second is that the safest foundation is one that has already held billions
            of dollars across multiple market cycles, so Lazy inherits its vault structure from
            the ERC-4626 patterns refined by Yearn, Morpho, and the rest of the ecosystem.
          </p>
          <p>
            The trade-off is real and worth saying plainly. Formal verification only proves the
            properties you wrote. If a property is missing, the proof cannot save you. Audits
            occasionally catch what proofs miss because human reviewers look at the code from
            angles a property specification does not. We chose proof over audit because we
            wanted certainty on the properties that matter most, not a signature on a report.
          </p>
        </Section>

        {/* §02 Invariants */}
        <Section num="§02" tag="Invariants" title={<>Five verified <em>invariants.</em></>}>
          <p className="sec-section-intro">
            These hold across every reachable state of the vault, proven under Halmos symbolic
            execution. The full test source is in the repository.
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
            Halmos is a symbolic execution tool for Solidity. Instead of testing your contract
            with specific input values, it represents inputs as mathematical symbols and explores
            every path the contract could take. If an invariant holds under Halmos, it holds for
            all reachable states reachable through the modeled paths, not just the cases someone
            thought to test.
          </p>
          <p>
            Regular tests answer the question "does this work for the inputs I tried?" Symbolic
            execution answers "does this work for any input that could possibly reach this code?"
            The difference matters when the cost of being wrong is depositor capital. Halmos
            cannot find a bug that hides in an input you wrote a test for; it proves a property
            holds across the entire input space at once.
          </p>
          <p>
            What Halmos cannot do is reason about off-chain components or operator behavior. It
            proves the on-chain contract logic, full stop. The trust assumptions outside that
            scope, like the multisig returning capital, live in the residual risk section below
            and on the docs page.
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

        {/* §04 Battle-tested */}
        <Section num="§04" tag="Foundation" title={<>Battle-tested <em>base contracts.</em></>}>
          <p>
            Lazy's vault inherits from the ERC-4626 pattern shipped by Yearn and refined across
            the rest of the ecosystem by Morpho, Sommelier, Origin, and others. These contracts
            have collectively held billions of dollars across multiple market cycles, through bear
            markets, depegs, and protocol failures elsewhere. They are not academic code. The
            risk of an unknown bug in those base layers is materially lower than the risk in
            equivalent custom code. The parts Lazy modified are the parts we proved with Halmos.
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
              No traditional third-party audit has been engaged. Formal verification covers the
              properties we wrote and proved. It does not cover properties we did not think to
              write.
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
