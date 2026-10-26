# Risk model

This document explains how Pumpraelie scores risk, which conditions block trading outright, how the thresholds work, and how to evaluate the model against history.

> **The risk score is a heuristic ranking, not a probability.** A score of 20 does **not** mean a 20% chance of a rug pull. The weights and points below are engineering defaults that have **not** been statistically calibrated. Some scams are undetectable until they happen (for example a coordinated dump by wallets with no prior on-chain history).

Code: `src/server/analysis/risk.ts`, `features.ts`, `profitability.ts`, `assessment.ts`, `src/server/risk/riskManager.ts`.

## 1. Inputs and their sources

| Input | Source | Notes |
|---|---|---|
| Trades (side, SOL, tokens, trader, reserves after trade) | Solana RPC `logsSubscribe` on the Pump program, decoded with the official SDK IDL | Primary. Failed transactions are counted but never treated as trades. |
| Curve / pool state | `getMultipleAccountsInfo` on bonding curve / canonical PumpSwap pool PDAs | Authoritative. Used for reconciliation and fills. |
| Mint account | `getMultipleAccountsInfo` on the mint | Token program, decimals, supply, mint/freeze authority, Token-2022 extensions, metadata. |
| Holders | `getTokenLargestAccounts` (top 20) + owner resolution | Often rate-limited on public RPC. Fallback: estimate from observed trade flows (lower confidence; transfers are invisible). |
| Creator history | Pumpraelie's own observations (launch counts, graduations, flags) + `getSignaturesForAddress` | Evidence is limited to what this installation has seen. |
| Aggregates for graduated tokens | DexScreener `/tokens/v1/solana/…` | Cross-check only. |
| New tokens, migrations | PumpPortal free WebSocket | Independent discovery source. Its "SOL" figures are never used for pricing. |

A missing field is reported as unavailable (`risk.missing`). **Missing holder, mint or liquidity data adds risk; it is never treated as evidence of safety.**

## 2. Category scores

Each category adds up the points of its findings, weighted by confidence (minimum 0.5×), capped at 100. Each finding records its code, severity, message, points, source, timestamp and confidence. The dashboard shows them all.

| Category | Default weight | Main findings (points) |
|---|---:|---|
| Liquidity & exit | 25% | tiny liquidity <1 SOL (50) · below `MIN_EXIT_LIQUIDITY_SOL` (30) · exit impact for the reference size > limit (30) / > 3× limit (60, critical) · exit not fillable (80, critical) · liquidity −25% from 5-min high (35) / −50% (70, critical) · sell volume >2× buys (20) · non-SOL quote (100, critical) · migrating (60, critical) · route account missing (100, critical) |
| Holder concentration | 20% | top holder >10% (25) / >20% (50) · top 10 >35% (20) / >50% (40) · creator >5% (15) / >10% (30) · launch-window buyers still holding >12% (15) / >25% (30) · ≥3 top holders selling within 2 min (35) · unknown distribution (45) · estimated from flows (10) |
| Creator & wallets | 20% | creator sold ≥20% (35) / ≥80% (70, critical `CREATOR_DUMPING`) · creator linked to previously flagged launches (45) · ≥5 launches in 24h (40), ≥2 (15) · ≥3 launches with no graduation (10) · ≥60 tx in the last hour (20) · creator unknown (30) |
| Trading anomalies | 15% | top-3 wallets >60% of volume (30) · round-trip wallets >50% of volume (30) · repeated identical sizes >40% (25) · >6 trades per wallet (15) · volatility >60% with <20 SOL liquidity (20) · 5m volume >3× liquidity (20) · +300% in 5m (20) · −40% from 1h peak (30) · −25% in 1m (25) · copycat name/symbol (10–30) |
| Permissions & mechanics | 10% | mint authority set (100, critical) · freeze authority (100, critical) · TransferHook / PermanentDelegate / NonTransferable / DefaultAccountState / Pausable / PermissionedBurn (100, critical) · transfer fee/tax (80, critical) · non-6 decimals (30) · mint unverified (40, critical-missing) · mayhem mode (60, critical `NONSTANDARD_MECHANICS`) |
| Data reliability | 10% | stale > `STALE_DATA_MS` (60, critical) · stream vs chain mismatch >5% (60, critical) / >1% (20) · not reconciled on-chain (30) · <10 trades (20) · history not from launch (10) · token <5 min old (25) / <15 min (10) · critical provider unhealthy (40) |

**Score** = Σ(category score × normalized weight). If any critical flag is present, the score is raised to at least 65 ("very high"), so a token can never look benign while it carries a critical condition. **Data confidence** = 1 − reliability score/100 − 0.05 per missing input.

Protocol accounts are excluded from concentration. The bonding-curve PDA, the PumpSwap pool authority and pool vaults are labelled and removed, and multiple token accounts owned by one wallet are combined. This avoids the common false positive where the curve appears to "own 80%".

## 3. Critical flags (always block entries)

`EXIT_ROUTE_UNAVAILABLE`, `UNSUPPORTED_QUOTE_ASSET`, `SEVERE_LIQUIDITY_DETERIORATION`, `TRANSFER_RESTRICTION`, `MINT_AUTHORITY_ACTIVE`, `EXTREME_EXIT_IMPACT`, `CRITICAL_DATA_MISSING`, `DATA_STALE`, `DATA_INCONSISTENT`, `CREATOR_DUMPING`, `MIGRATION_IN_PROGRESS`, `NONSTANDARD_MECHANICS`.

A high opportunity score can never offset a critical flag. For open positions, the exit policy sells immediately on `SEVERE_LIQUIDITY_DETERIORATION`, `CREATOR_DUMPING`, `TRANSFER_RESTRICTION`, `MINT_AUTHORITY_ACTIVE` or `EXTREME_EXIT_IMPACT`. On `DATA_STALE` / `DATA_INCONSISTENT` it **holds**, because selling blind against bad data can be worse.

## 4. Tiers and the default trading policy

| Score | Tier | Default policy |
|---|---|---|
| 0–24 | lower (not "safe") | evaluate opportunity and execution |
| 25–44 | moderate | evaluate opportunity and execution |
| 45–64 | high | rejected unless the operator lists the strategy in `allowHighRiskStrategies` **and** it requests high risk, and every other gate passes |
| 65–79 | very high | rejected |
| 80–100 | extreme | rejected; open positions are sold by the exit policy |

`MAX_RISK_SCORE` (default 44) is an additional ceiling, clamped to `HARD_MAX_RISK_SCORE` (64).

## 5. Profitability and the entry decision

For a position of size S, Pumpraelie simulates against the constant-product state:

1. **Latency drift**: the price moves against us by 0.5 × σ₅ₘ × √(latency / 5 min) before inclusion.
2. **Entry**: buy with S (fees on top, as both programs charge them) against the drifted reserves; this includes our own impact.
3. **Scenarios**, measured from the **decision-time** price so drift and impact are real costs:
   - bull: target reached (+target%)
   - base: −2% drift, time exit
   - bear: −(stop + 0.35 × σ₅ₘ, capped at 30%), i.e. the stop gaps
   - rug: −85% with 85% of liquidity drained
4. **Exit**: sell the full position into each scenario state, with payouts capped by withdrawable reserves and sell fees deducted. Net P&L = exit proceeds − entry cost − network fees (base + priority, both legs).
5. **Probabilities** (heuristic, uncalibrated): P(rug) = clamp(0.02 + 0.6·(risk/100)², 0.02, 0.6). The remainder is split bull/base/bear by opportunity quality q: bull (0.20+0.25q), bear (0.45−0.20q).
6. **Expected net** = Σ p·net. **Reward/risk** = E[gains] / |E[losses]|.

An entry needs **all** of: a strategy signal, no account blockers, risk policy OK, on-chain reconciliation in the last 15s, size ≥ 0.005 SOL after every cap, expected net ≥ `MIN_EXPECTED_NET_RETURN_PCT`, reward/risk ≥ `MIN_REWARD_TO_RISK`, entry and exit impact ≤ `MAX_PRICE_IMPACT_PCT`, liquidity ≥ `MIN_EXIT_LIQUIDITY_SOL`, and the network fee ≤ `MAX_TX_FEE_SOL`.

**Sizing** = min(position % of capital, hard cap, risk budget / (stop + round-trip cost), largest size within the impact limit, remaining exposure, available cash after the fee reserve, strategy allocation). The result is then multiplied by tier (1.0 lower, 0.6 moderate, 0.3 high) and by 0.7 if 5-minute volatility exceeds 50%. Capital base = min(configured capital, current equity).

## 6. Evaluating the model with historical data

Pumpraelie records every SOL-quoted Pump trade, plus mint and holder snapshots, which makes the dataset survivorship-free: tokens that died are included.

1. **Collect data**: run in paper or offline mode for at least several days (retention defaults to 48h raw trades, so raise `RETENTION_RAW_TRADES_HOURS` for longer studies).
2. **Backtest**: Strategy lab → *Run backtest*, or `npm run backtest -- --train 0.7`. The replay rebuilds market state strictly from events with `ts ≤ t` and uses only snapshots observed before `t`. The test suite verifies that appending future data never changes earlier decisions.
3. **Read calibration signals** in the results:
   - *Quoted expected vs realized*: mean decision-time expected net % vs mean realized %. A large gap means the scenario probabilities are over-optimistic.
   - *Results by risk tier*: realized loss rate and P&L should get worse as the tier rises. If not, the weights are not separating risk.
   - *Unexecutable exit rate* and the *byCloseReason* breakdown (stop / risk escalation / liquidity).
4. **Calibrate** (manual, deliberate): to turn scores into probabilities you need labelled outcomes. For example, define "rug" as liquidity −80% within 30 minutes of the decision, then fit a monotone (isotonic or logistic) mapping from score to observed frequency on an in-sample period and validate it out of sample. Only after that can a score be read as a probability. Weights are configurable (`riskWeights`), but **change them only with out-of-sample evidence**.
5. The optimizer (`/api/strategies/:id/optimize`) tunes **strategy** parameters only. It requires an out-of-sample improvement over the current baseline, at least 5 out-of-sample trades, positive out-of-sample return, and in-sample profit not concentrated in one token. It produces a proposal the operator accepts or rejects. Safety limits are never part of the search space.

## 7. Known limitations

- Holder data from public RPC is often unavailable. Flow-based estimates miss transfers and pre-observation buys.
- Creator history only covers launches observed by this installation. Cross-installation reputation data is not used.
- Wallet-cluster detection is heuristic (round-tripping, repeated sizes, synchronized selling by top holders). There is no graph analysis of funding sources.
- Scenario probabilities are not calibrated (see §6). Treat expected-value numbers as a ranking signal and verify realized results.
- Mayhem-mode coins and non-SOL-quoted curves are excluded rather than modelled.
- Bonding-curve fee tiers are read from on-chain `FeeConfig` via the SDK. If they change while running, the fee used for a token updates on its next reconciliation.
