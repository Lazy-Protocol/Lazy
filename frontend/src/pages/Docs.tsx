import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

type ArticleProps = {
  num: string;
  tag: string;
  title: string;
  children: React.ReactNode;
};

function Article({ num, tag, title, children }: ArticleProps) {
  return (
    <section className="lpx-article">
      <div className="lpx-art-gutter">
        <div className="lpx-art-gutter-sticky">
          <div className="lpx-art-roman">{num}</div>
          <div className="lpx-art-tag">{tag}</div>
          <div className="lpx-art-stripe" aria-hidden />
        </div>
      </div>
      <div className="lpx-art-content">
        <h2 className="lpx-art-title">{title}</h2>
        <div className="lpx-art-body">{children}</div>
      </div>
    </section>
  );
}

export function Docs() {
  usePageMeta({
    title: 'Lazy Docs · Patient capital, explained.',
    description:
      'How the Lazy vault works, what it does with capital, and what risks you take when you deposit. Plain English. No jargon.',
    canonical: '/docs',
  });

  return (
    <div className="lpx">
      {/* Cover */}
      <header className="lpx-cover">
        <div className="container">
          <div className="lpx-mark">
            <span className="lpx-mark-dot" aria-hidden />
            <span>Documentation</span>
          </div>

          <div className="lpx-title-block">
            <h1 className="lpx-title">
              Lazy<br />
              <em>Docs.</em>
            </h1>
          </div>

          <div className="lpx-deks">
            <p className="lpx-dek lpx-dek-lead">
              Lazy is a vault for patient capital.
            </p>
            <p className="lpx-dek">
              You deposit once, receive lazyUSD tokens, and let the protocol route capital into
              yield strategies without the staking, claiming, or constant position management
              DeFi usually demands.
            </p>
            <p className="lpx-dek lpx-dek-sub">
              This is the plain-English version of how Lazy works, what it does with capital, and
              what risks you take when you deposit.
            </p>
          </div>
        </div>
      </header>

      {/* Articles */}
      <div className="container">
        <div className="lpx-articles">
          <Article num="01" tag="Overview" title="What Lazy is.">
            <p className="lpx-drop">
              Lazy is built for users who want yield without actively moving funds across venues
              themselves. You deposit, the vault handles the rest, and you can leave it alone.
            </p>
            <p>
              Your balance is represented by lazyUSD tokens. The value of those tokens moves with
              the vault's net asset value, which reflects what the protocol actually holds.
            </p>
          </Article>

          <Article num="02" tag="Mechanics" title="How Lazy works.">
            <ol className="lpx-register">
              <li>You deposit supported assets into a Lazy vault.</li>
              <li>The vault issues lazyUSD tokens representing your position in the vault.</li>
              <li>The protocol deploys capital into yield strategies.</li>
              <li>Yield changes the vault's net asset value.</li>
              <li>When you withdraw, you redeem lazyUSD for your portion of the vault assets.</li>
            </ol>
          </Article>

          <Article num="03" tag="Operations" title="What the vault does.">
            <p>
              The vault runs three strategies in parallel. None of them depend on the market going
              up. Each one is either delta-neutral or fully hedged, so yield comes from structure
              rather than from picking a direction.
            </p>

            <div className="lpx-strategies">
              <div className="lpx-strategy">
                <div className="lpx-strategy-label">
                  <span className="lpx-strategy-num">i.</span>
                  <span>Basis yield</span>
                </div>
                <div className="lpx-strategy-body">
                  <p>
                    Lazy holds spot exposure and offsets it with a short perpetual position of the
                    same size. The perp pays funding while it's held, and that funding stream is
                    the yield. Because the spot and the short are paired, the position has no
                    directional exposure: if the price moves up, the spot gains and the perp
                    loses by the same amount, and the funding stays.
                  </p>
                </div>
              </div>

              <div className="lpx-strategy">
                <div className="lpx-strategy-label">
                  <span className="lpx-strategy-num">ii.</span>
                  <span>Options arbitrage</span>
                </div>
                <div className="lpx-strategy-body">
                  <p>
                    The same option is often priced differently on different venues. Lazy sells
                    the option on the venue where implied volatility is rich and buys it on the
                    venue where implied volatility is cheap. The spread between the two prices is
                    the yield, captured trade by trade. The position is hedged the moment it's
                    opened, so the vault is not exposed to where the underlying goes next.
                  </p>
                </div>
              </div>

              <div className="lpx-strategy">
                <div className="lpx-strategy-label">
                  <span className="lpx-strategy-num">iii.</span>
                  <span>Gamma scalping</span>
                </div>
                <div className="lpx-strategy-body">
                  <p>
                    Lazy holds an options position and continuously rehedges its delta as the
                    underlying moves. Each rehedge locks in a small amount of the underlying's
                    realized movement. When the market actually moves more than the option's
                    implied volatility priced in, those rehedges accumulate into profit. When it
                    moves less, the position bleeds the premium it paid. The strategy earns the
                    gap between realized volatility and implied volatility.
                  </p>
                </div>
              </div>
            </div>

            <p>
              Underneath the three strategies, the vault also handles the operational work:
              allocating capital across venues, tracking positions on-chain, calculating net
              asset value, and processing deposits and withdrawals through lazyUSD tokens.
            </p>

            <p className="lpx-pull">
              The goal is simple: make yield feel passive without hiding how it works.
            </p>
          </Article>

          <Article num="04" tag="Accounting" title="Net asset value.">
            <p className="lpx-lede">Lazy calculates vault value from real positions.</p>
            <p>
              The vault's NAV reflects the assets and positions the protocol holds. Deposits and
              withdrawals do not create yield by themselves. Yield comes from the underlying
              strategies.
            </p>
            <p>lazyUSD price changes when the vault earns yield or takes losses.</p>
          </Article>

          <Article num="05" tag="Liquidity" title="Withdrawals.">
            <p>Withdrawals are processed through the vault's withdrawal flow.</p>
            <p>
              When you request a withdrawal, your lazyUSD enters a queue and is fulfilled in the
              order it was received. You receive assets based on the vault's net asset value at
              the time your withdrawal is processed, not at the time you requested it.
            </p>
            <p className="lpx-emphasis">
              Withdrawal processing can take up to 7 days.
            </p>
            <p>
              The delay exists because capital is deployed in active positions. The vault has to
              unwind those positions in an orderly way before it can return funds. Rushing that
              process would mean exiting at worse prices and giving up yield that already belongs
              to depositors. Most withdrawals settle faster, but you should plan for the full
              window.
            </p>
            <p>
              lazyUSD in the queue continues to accrue value until it is processed. If the vault
              gains during the wait, you receive that gain. If the vault loses, you take that
              loss. This keeps the system fair: nobody is penalised for waiting their turn, and
              nobody can lock in a price ahead of the depositors behind them.
            </p>
          </Article>

          <Article num="06" tag="Security" title="Security.">
            <p>Lazy is built around three principles:</p>
            <ul className="lpx-items">
              <li>transparent vault accounting</li>
              <li>on-chain position visibility</li>
              <li>conservative withdrawal handling</li>
            </ul>
            <div className="lpx-plate">
              <div className="lpx-plate-head">
                <span>On the residual risk surface</span>
              </div>
              <p>
                Smart contract risk, strategy risk, venue risk, liquidity risk, and market risk
                still exist. Lazy reduces manual work; it does not remove risk.
              </p>
              <p>
                The vault currently has exposure to{' '}
                <span className="lpx-plate-venues">Derive</span>,{' '}
                <span className="lpx-plate-venues">Pendle</span>,{' '}
                <span className="lpx-plate-venues">Hyperliquid</span>,{' '}
                <span className="lpx-plate-venues">Lighter</span>, and{' '}
                <span className="lpx-plate-venues">Rysk</span>, and from time to time to{' '}
                <span className="lpx-plate-venues">Hyperlend</span>. A failure, exploit, or
                downtime at any of these venues can affect the vault's positions and the value of
                your lazyUSD.
              </p>
              <p>
                Before depositing, users should understand the vault, the strategy, the supported
                assets, the withdrawal process, and the venues the vault relies on.
              </p>
            </div>
          </Article>

          <Article num="07" tag="Disclosure" title="Risks.">
            <p>Using Lazy involves risk, including:</p>
            <ul className="lpx-items">
              <li>loss of principal</li>
              <li>smart contract bugs</li>
              <li>strategy losses</li>
              <li>liquidity constraints</li>
              <li>counterparty or venue risk</li>
              <li>delayed withdrawals</li>
              <li>changes in market conditions</li>
            </ul>
            <p className="lpx-emphasis">Lazy is not a bank account. Yield is not guaranteed.</p>
          </Article>

          <Article num="08" tag="Economics" title="Fees and target yield.">
            <div className="lpx-figures">
              <div className="lpx-figure">
                <div className="lpx-figure-label">Target APR</div>
                <div className="lpx-figure-value">10%</div>
                <div className="lpx-figure-note">Not a guarantee</div>
              </div>
              <div className="lpx-figure">
                <div className="lpx-figure-label">Performance fee</div>
                <div className="lpx-figure-value">20%</div>
                <div className="lpx-figure-note">On yield only</div>
              </div>
            </div>

            <p>
              Lazy targets a 10% annualised return on deposited capital. This is a target, not a
              guarantee. Actual returns depend on funding rates, options pricing across venues,
              and how much the market moves during the gamma scalping window. Some weeks will be
              well above the target, some well below.
            </p>

            <p>
              The protocol takes a 20% performance fee on yield generated by the vault. The fee
              is only applied to positive yield. It is never taken from principal, and it is not
              taken on weeks where the vault loses money. Net yield, after the fee, is what is
              reflected in your lazyUSD.
            </p>

            <p className="lpx-emphasis">
              Always check the live app before depositing for the current target and the fee in
              effect at that time.
            </p>
          </Article>

          <Article num="09" tag="Audience" title="Who Lazy is for.">
            <p>
              Lazy is for long-term holders who want automated yield exposure without manually
              managing every step themselves.
            </p>
            <p>
              It is not for users who need instant liquidity, guaranteed returns, or a risk-free
              place to park funds.
            </p>
          </Article>

          {/* Colophon */}
          <section className="lpx-colophon">
            <div>
              <div className="lpx-colophon-tag">Colophon</div>
            </div>
            <div>
              <p>
                This documentation was written with the help of{' '}
                <a
                  href="https://usenoren.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lpx-link"
                >
                  Noren
                  <ArrowUpRight size={12} />
                </a>
                , a tool for keeping AI-assisted writing in your own voice.
              </p>
            </div>
          </section>

          {/* Footer */}
          <footer className="lpx-footmark">
            <span className="lpx-footmark-left">Lazy Protocol</span>
            <Link to="/#vaults" className="lpx-footmark-cta">
              <span>View vaults</span>
              <ArrowUpRight size={14} />
            </Link>
          </footer>
        </div>
      </div>
    </div>
  );
}
