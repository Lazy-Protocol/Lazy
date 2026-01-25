# Ambassador Onboarding Guide

## Welcome to Lazy Protocol

Lazy Protocol partners with a select group of voices who understand the value of patience. This guide outlines how the referral partnership works and what we expect from each other.

---

## Why Lazy

Most yield protocols demand attention. Lazy does not.

Your referrals deposit once. The yield compounds automatically. Your earnings follow the same principle: no claims, no management, no overhead.

This is a partnership for patient capital.

---

## What is Lazy Protocol?

Lazy Protocol is a yield-generating vault for USDC on Ethereum. Users deposit USDC and receive lazyUSD, a share token that automatically appreciates as yield accrues.

No staking. No claiming. Just yield.

**Key Stats:**
- Asset: USDC (stablecoin)
- Chain: Ethereum Mainnet
- APR: Variable (check getlazy.xyz for current rates)
- Protocol Fee: 20% of yield generated

---

## How the Protocol Works

This section explains the mechanics so you can accurately represent Lazy to your audience.

### The Deposit Process

1. **User connects wallet** to getlazy.xyz
2. **User approves USDC** spending (one-time per wallet)
3. **User deposits USDC** into the vault
4. **User receives lazyUSD** — a share token representing their portion of the vault

**Example:**
```
User deposits: 10,000 USDC
Current share price: $1.004 per lazyUSD
User receives: ~9,960 lazyUSD shares
```

### How Yield Is Generated

The vault employs two concurrent strategies:

- **Basis trading** — Long spot assets (SOL, LIT), short perpetual futures on Hyperliquid and Lighter. This captures funding rates while remaining market-neutral.
- **Pendle PT** — Fixed-yield principal tokens that lock in predictable returns at maturity.

All positions are visible on-chain. Users can verify backing at any time via the Backing page (getlazy.xyz/backing).

Users hold lazyUSD; the vault handles execution and rebalancing. Your role as an ambassador is to clarify the *outcome* (yield), not the mechanics. For deeper technical details, direct users to getlazy.xyz/docs.

### The Share Price Mechanism

This is the key concept that makes Lazy "lazy":

- **lazyUSD is a share token**, not a rebasing token
- The **share price increases** as the vault earns yield
- Users don't receive yield payments — their lazyUSD simply becomes worth more USDC over time

**Example over 1 year:**
```
Day 1:   1 lazyUSD = $1.000 USDC
Day 90:  1 lazyUSD = $1.025 USDC (+2.5%)
Day 180: 1 lazyUSD = $1.051 USDC (+5.1%)
Day 365: 1 lazyUSD = $1.104 USDC (+10.4%)
```

The user's lazyUSD balance stays the same. The value of each lazyUSD increases.

### Withdrawals

Withdrawals use a **queue system** with a **cooldown period**:

1. **User requests withdrawal** — specifies how many lazyUSD shares to withdraw
2. **Cooldown period** — currently 7 days (protects against bank-run scenarios)
3. **Withdrawal is fulfilled** — user receives USDC at current share price

**Why the cooldown?**
- Allows the vault to unwind positions safely
- Protects remaining depositors from forced liquidations
- Standard practice for institutional-grade vaults

### Protocol Fees

The protocol takes a **20% performance fee** on yield generated:

```
Vault earns: $10,000 in yield
Protocol fee: $10,000 × 20% = $2,000
Net to depositors: $8,000 (reflected in share price)
```

The fee is only on **yield**, not on deposits. If the vault earns nothing, no fee is taken.

### Security

- **Audited smart contracts** — Professional third-party audits
- **Role-based access control** — Multi-sig for critical operations
- **No user custody** — Users can always withdraw their funds
- **Transparent on-chain** — All vault activity is publicly verifiable

More details: getlazy.xyz/security

---

## The Ambassador Program

### How It Works

1. You receive a **unique referral link** (e.g., `getlazy.xyz?ref=yourhandle`)
2. When someone deposits using your link, they become your **referral**
3. You earn a share of protocol fees generated from your referrals' yield
4. Payouts are **weekly** and **automatic**

### Your Earnings

You earn a share of the protocol's performance fee. When your referrals generate yield, so do you.

**Example Calculation:**

| Metric | Amount |
|--------|--------|
| Your referrals' total deposits | $1,000,000 |
| Annual yield (example: 10%) | $100,000 |
| Protocol fee (20%) | $20,000 |
| **Your share (50%)** | **$10,000/year** |

Your exact fee share percentage is agreed upon during onboarding.

### Partner Tiers

| Tier | Fee Share | Criteria |
|------|-----------|----------|
| Standard | 25% | Default tier for new partners |
| Growth | 35% | $500K+ referred AUM + consistent brand alignment |
| Premium | 50% | $1M+ referred AUM + exemplary brand representation |

*Tier advancement requires both volume AND continued alignment with Lazy's brand guidelines. We reserve the right to adjust tiers based on content quality.*

---

## Your Referral Link

Your personalized referral link follows this format:

```
https://getlazy.xyz?ref=yourhandle
```

**Details:**
- Your handle is **case-insensitive** (`YourHandle` = `yourhandle`)
- The referral is stored in the user's browser for **30 days**
- Once a user deposits with your referral, the relationship is **permanent**
- Users cannot change their referrer after their first deposit

### Tracking Parameters

You can add UTM parameters for your own analytics:

```
https://getlazy.xyz?ref=yourhandle&utm_source=twitter&utm_campaign=launch
```

---

## Partner Dashboard

Access your dashboard at: **getlazy.xyz/kol**

Connect with your registered wallet to see:

- **Total Referrals**: Users who deposited with your link
- **Total AUM**: Combined deposits from all your referrals
- **This Week's Earnings**: Projected payout for current period
- **Total Earned**: All-time earnings from the program
- **Referral List**: Individual breakdown of each referral

---

## Payout Schedule

### Weekly Distribution

- **Cycle**: Every 7 days
- **Calculation**: Based on yield generated by your referrals during the period
- **Payment**: USDC sent directly to your registered wallet
- **Automatic**: No claiming required

### How Payouts Are Calculated

Each week:

1. System calculates total yield earned by your referrals
2. Protocol fee (20%) is applied to that yield
3. Your share of the protocol fee is calculated
4. USDC is transferred to your wallet

**Example:**
```
Your referrals earned $1,000 in yield this week
Protocol fee: $1,000 × 20% = $200
Your share (50%): $200 × 50% = $100

You receive: $100 USDC
```

---

## What Counts as Yield

Your earnings are based on **yield from share price appreciation**, not deposit size.

### Included:
- Yield earned on deposits made with your referral link
- Yield on additional deposits made by the same user

### Not Included:
- The principal deposit amount
- Yield earned before the user was referred to you
- Yield from users who didn't use your link

### If a User Withdraws

If your referral withdraws some or all of their funds:
- You stop earning on the withdrawn portion
- You continue earning on any remaining balance
- If they deposit again later, you resume earning on the new deposit

---

## Content Guidelines

### Our Voice

Lazy's brand is built on understatement. We don't hype. We don't create urgency. We state facts and let the product speak.

Your content should:
1. **Lead with value, not urgency** — Explain what Lazy does, not why they need to act NOW
2. **Be honest about trade-offs** — Mention withdrawal cooldowns, not just yield
3. **Never guarantee returns** — APR is variable; past performance doesn't guarantee future results
4. **Disclose your referral relationship** — Where required by platform, always disclose

### Approved Messaging

**Use these phrases:**
- "Earn yield on USDC with no active management"
- "Deposit and let your money work for you"
- "Patient capital, rewarded"
- "No staking, no claiming, just yield"

### Content We'll Ask You to Revise

- Claims about guaranteed or fixed returns
- Comparisons to bank savings or "risk-free" investments
- Urgency tactics ("last chance," "limited time," "don't miss out")
- Degen language (moon, rocket, WAGMI, LFG, "ape in")
- Any content that could mislead about risk

**Why these rules exist:** Lazy Protocol operates with full transparency. Overpromising undermines trust. Our users are not looking for hype. They are looking for clarity.

### Required Disclosures

When promoting Lazy Protocol, include:
- This is DeFi and carries smart contract risk
- Past performance doesn't guarantee future results
- Your referral link disclosure (where required by platform)

### Content Review (Optional)

We offer optional pre-publication review for partners who want feedback. Send drafts to your partnership contact at least 48 hours before posting.

---

## What We Expect from Partners

### Brand Alignment

Lazy partners are ambassadors, not affiliates. We expect:

- Content that reflects Lazy's values: patience, simplicity, honesty
- No engagement farming, giveaway schemes, or artificial urgency
- Transparent disclosure of your referral relationship
- Willingness to correct or remove content that misrepresents Lazy

### Termination

We reserve the right to end partnerships if:

- Content consistently misrepresents Lazy or DeFi risk
- Partner promotes competing yield products alongside Lazy
- Brand alignment deteriorates significantly
- Referral activity appears fraudulent or manipulated

Terminated partners forfeit future earnings; earned payouts to date are honored.

---

## Getting Started

### Step 1: Registration

Your wallet address and handle are registered by the Lazy team. You will receive confirmation when your account is active.

**You'll need to provide:**
- Ethereum wallet address (for payouts)
- Preferred handle (for your referral link)

### Step 2: Verify Access

1. Go to **getlazy.xyz/kol**
2. Connect your registered wallet
3. Confirm your handle and statistics appear correctly

### Step 3: Begin

Share your referral link. Track performance on your dashboard.

That is all.

---

## Frequently Asked Questions

### General

**Q: When do I start earning?**
A: You start earning as soon as someone deposits using your link and the vault generates yield on their deposit.

**Q: Is there a minimum payout?**
A: No minimum. However, very small amounts may accumulate over multiple weeks before distribution.

**Q: Can I have multiple referral handles?**
A: No, one handle per wallet address.

**Q: Can I change my handle?**
A: Contact the team to request a handle change.

### Earnings

**Q: Why is my projected earning different from my actual payout?**
A: Projections are estimates based on current share price. Actual payouts depend on final yield at distribution time.

**Q: What if the vault has negative yield one week?**
A: Earnings are only calculated on positive yield. Negative periods do not affect your balance.

**Q: Are payouts in USDC or lazyUSD?**
A: All payouts are in USDC, sent directly to your wallet.

### Referrals

**Q: What if someone uses my link but doesn't deposit immediately?**
A: The referral is stored for 30 days. If they deposit within that window, they count as your referral.

**Q: Can users switch to a different partner's referral?**
A: No. Once a user deposits, their referrer is permanent.

**Q: What if my referral deposits from a different wallet?**
A: Each wallet is tracked separately. Only deposits from wallets that used your link count.

### Technical

**Q: What chain are payouts on?**
A: Ethereum Mainnet, same as the vault.

**Q: Do I need to pay gas for anything?**
A: No. Payouts are pushed to your wallet automatically.

**Q: Can I see my referrals' individual deposits?**
A: Yes, the dashboard shows each referral's current balance and your earnings from them.

---

## Support

For questions or issues, contact your partnership manager.

---

## Key Links

| Resource | URL |
|----------|-----|
| Main Site | https://getlazy.xyz |
| Partner Dashboard | https://getlazy.xyz/kol |
| Documentation | https://getlazy.xyz/docs |
| Security Info | https://getlazy.xyz/security |

---

*This guide is for registered partners. All terms are subject to individual agreements. Welcome to patient capital.*
