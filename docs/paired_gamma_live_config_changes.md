# Paired Gamma Live Config Changes

## 2026-06-04 02:48 Europe/Berlin

Reason: increase RFQ win competitiveness after recent HYPE bid logs showed repeated `maker_error_-32005` outbids and clearing observations above our submitted bids.

Changed live `.env` values:

- Completed-pair mark cap: `PAIRED_GAMMA_SECOND_LEG_MAX_MARK_MULTIPLIER` `1.00 -> 1.10`
- First-leg call bid lift: `PAIRED_GAMMA_CALL_BID_PATH_EXTRA_LIFT_PCT` unset/default `0.00 -> 0.05`
- First-leg mark cap: `PAIRED_GAMMA_BID_PATH_DERIVE_MARK_CAP_MULTIPLIER` `1.00 -> 1.05`
- APR cap within 3% moneyness: `PAIRED_GAMMA_APR_CAP_TIERS` first tier `190% -> 210%`

Unchanged APR tiers:

- Within 5% moneyness: `130%`
- Within 10% moneyness: `95%`

Rollback targets if wins become too aggressive:

- `PAIRED_GAMMA_SECOND_LEG_MAX_MARK_MULTIPLIER=1.00`
- remove `PAIRED_GAMMA_CALL_BID_PATH_EXTRA_LIFT_PCT` or set it to `0.00`
- `PAIRED_GAMMA_BID_PATH_DERIVE_MARK_CAP_MULTIPLIER=1.00`
- `PAIRED_GAMMA_APR_CAP_TIERS=0.03:1.90,0.05:1.30,0.10:0.95`
