# Strategies

A strategy only **proposes** an entry with a thesis, target, stop, trailing distance and maximum holding time. It never sizes positions, never bypasses the risk manager, and never places orders. All strategies share the same exit policy. Parameters are versioned in the `strategy_configs` table. They can be edited, marked known-good and reverted from the Strategy lab. Every change is audited.

Code: `src/server/strategy/strategies.ts`, `exitPolicy.ts`, `registry.ts`.

All strategies first require: a price, withdrawable liquidity ≥ `minLiquiditySol`, and a trade within the last 60 seconds.

## Momentum continuation (`momentum`, enabled by default)

Looks for sustained buying with positive multi-window momentum and adequate exit liquidity.

| Parameter | Default | Meaning |
|---|---:|---|
| minLiquiditySol | 8 | withdrawable SOL |
| minMomentum5mPct / maxMomentum5mPct | 8 / 80 | 5-minute move band (skips parabolic extensions) |
| minBuyShare | 0.58 | buy share of 5-minute volume |
| minUniqueTraders5m | 12 | breadth |
| maxDrawdownFromPeakPct | 15 | skip if far below the 1h peak |
| targetPct / stopPct / trailingPct / maxHoldSec | 25 / 12 / 10 / 900 | trade plan |

Also requires 1-minute momentum ≥ 0 and no liquidity decline worse than 15% from the 5-minute high.

## Volume acceleration (`volume_acceleration`, enabled by default)

Looks for an unusual increase in genuine activity: last-minute volume compared with the prior 5-minute per-minute average. Repetitive same-size trades and round-tripping wallets are discounted.

Defaults: acceleration ≥ 2.5×, 1-minute volume ≥ 2 SOL, prior baseline ≥ 0.5 SOL/min (a launch burst against zero history is not acceleration), repeated-size share ≤ 0.3, round-trip share ≤ 0.35, last-minute buy share ≥ 0.55; plan 20 / 10 / 8 / 600.

## Early-launch evaluation (`early_launch`, opt-in)

Covers young launches (60–600s) **observed from creation**, under stricter limits: risk ≤ 35, data confidence ≥ 0.6, ≥ 20 traders, positive momentum, and an **on-chain holder snapshot is required** (the flow estimate is not enough). Being early is never sufficient on its own. Disabled by default because public RPC rarely returns holder data for brand-new tokens.

## Pullback entry (`pullback`, enabled by default)

Looks for a retracement after a confirmed move: a 1h run-up ≥ 40%, a pullback of 15–40% from the peak, **stabilization** (1-minute momentum ≥ 0, last-minute buy share ≥ 0.55) and no liquidity decline worse than 10%. It never buys a falling price just because it fell.

## Exit and position protection (shared)

Evaluated on every tick against the **executable** value (a simulated full sell against current reserves, fees included). A stop is never assumed to fill at its level.

1. No executable quote, or stale/inconsistent data → **hold** and alert (no blind sells).
2. Critical risk escalation (liquidity collapse, creator dumping, transfer restriction, mint authority, extreme exit impact) → **sell now** (urgent: slippage tolerance doubled, bounded by `HARD_MAX_SLIPPAGE_PCT`).
3. Emergency policy active (daily loss or drawdown breached, policy `reduce`) → **sell**.
4. Executable P&L ≤ −stop → **sell**.
5. Risk score ≥ 80, or liquidity −30% from the 5-minute high → **sell**.
6. Target reached → **sell half**, then trail the rest.
7. Trailing stop: value ≤ peak × (1 − trailing%) after being at least 5% in profit → **sell**.
8. Maximum holding period → **sell**.
9. Risk tier escalates to very high → **sell half**.

Failed exits are retried only after the previous sell order reached a terminal state, so the bot never sends a blind duplicate sell. After 3 failures the position is marked **stuck**, a critical alert is raised, and retries continue at most once a minute. The operator can close it manually or, if the token is truly unsellable, write it off.

## Allocation and comparison

- `strategyAllocationPct` (risk settings) caps the capital share per strategy.
- The Strategy lab shows forward (paper/live) performance per strategy from closed positions, and backtest breakdowns by strategy, risk tier, launch age and market regime.
- The optimizer proposes parameter changes per strategy (see RISK_MODEL.md §6).
