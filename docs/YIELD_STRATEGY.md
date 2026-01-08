# Lazy Yield Strategy

## Overview

Delta-neutral basis trade combined with staking and Pendle PT yields to generate sustainable 10%+ APR on stablecoin deposits.

## Capital Allocation

```
USDC Deposit (100%)
│
├── 30% → Perp Collateral
│         • Venue: Lighter (may move to Hyperliquid)
│         • Position: Short perp equal to spot size
│         • Leverage: ~3x
│
└── 70% → Spot Purchase
          • Venue: Hyperliquid
          │
          ├── 70% of spot (49% of total) → Pendle PT
          │   • Maturity: <2 months
          │   • Protocols: Trusted/blue-chip only
          │
          └── 30% of spot (21% of total) → Liquid Staking
              • ETH: stETH, weETH
              • SOL: mSOL, jitoSOL
              • HYPE: stHYPE, kHYPE, vHYPE
```

## Assets

- ETH
- HYPE
- SOL

## Yield Sources

| Source | Type | Expected Yield | Notes |
|--------|------|----------------|-------|
| Funding rates | Variable | 5-20%+ | From short perp position |
| Pendle PT | Fixed | 5-15% | Discount to face value |
| Liquid staking | Variable | 3-8% | Protocol staking rewards |
| **Combined** | | **≥10% APR** | Target minimum |

## Venues

| Function | Venue | Notes |
|----------|-------|-------|
| Spot trading | Hyperliquid | Buy underlying assets |
| Perp trading | Lighter | May consolidate to Hyperliquid |
| Fixed yield | Pendle | PT tokens, <2mo maturity |
| Liquid staking | Various | stHYPE, kHYPE, vHYPE, etc. |

## Operational Cadence

| Task | Frequency | Trigger |
|------|-----------|---------|
| Perp margin top-up | As needed | Liquidation proximity |
| Hedge ratio rebalance | Every 2-7 days | Delta drift |
| PT rollover | Before maturity | <2 month cycles |
| Yield reporting | After realization | Report to vault |

## Risk Management

### Liquidation Risk
- **Cause:** Violent upward price moves (short perp loses)
- **Mitigation:** Monitor margin ratio, top up collateral proactively
- **Leverage:** ~3x (conservative for basis trade)

### Negative Funding
- **Cause:** Market sentiment shift
- **Mitigation:** Hold through; PT fixed yield provides cushion

### PT Illiquidity
- **Cause:** Need to exit before maturity
- **Mitigation:** Short maturities (<2 months), trusted protocols only

### Smart Contract Risk
- **Mitigation:** Blue-chip protocols only, audited venues

## Infrastructure

### Custody
- Fully onchain
- Multisig for treasury
- Hardware wallet for operator

### Execution
- Currently: Manual
- Planned: Automation for monitoring and rebalancing

## Automation Roadmap

### Phase 1: Monitoring
- [ ] Liquidation alerts (Telegram/Discord)
- [ ] Hedge ratio drift monitor
- [ ] Funding rate dashboard

### Phase 2: Semi-Automated
- [ ] Auto margin top-up keeper bot
- [ ] Rebalance transaction builder

### Phase 3: Full Automation
- [ ] PT maturity calendar with auto-rollover
- [ ] Yield attribution tracking
- [ ] Automated hedge rebalancing

## Example Flow

1. User deposits 10,000 USDC to vault
2. Operator allocates:
   - 3,000 USDC → Lighter as perp collateral
   - 7,000 USDC → Buy spot on Hyperliquid (e.g., ETH at $3,000 = 2.33 ETH)
3. Open short perp on Lighter for 2.33 ETH (delta neutral)
4. Deploy spot:
   - 1.63 ETH (70%) → Pendle PT-weETH (1.5 month maturity)
   - 0.70 ETH (30%) → weETH (liquid staking)
5. Yield accrues from:
   - Funding payments (daily)
   - PT discount (at maturity)
   - Staking rewards (continuous)
6. Rebalance hedge every 2-7 days
7. Roll PT before maturity
8. Report yield to vault periodically

---

*Last updated: January 2026*
