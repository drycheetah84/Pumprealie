# Progress

_Last updated: 2026-10-26_

## Status summary

All seven phases are implemented. The application builds, starts, ingests live Solana mainnet Pump data, analyzes and explains tokens, runs the full paper-trading lifecycle, persists all state, and serves the dashboard. Live execution is implemented and **disabled by default**.

## Implemented

### Phase 1 — Foundation
- [x] TypeScript project (CommonJS server, Vite/React dashboard), strict typing, ESLint
- [x] zod-validated configuration (`.env.example` documents every variable); runtime risk settings clamped to `HARD_*` limits
- [x] SQLite (WAL) with ordered migrations, unique constraints for idempotency and active positions/orders
- [x] Structured logging (pino) with secret redaction; graceful shutdown

### Phase 2 — Market data
- [x] Solana RPC `logsSubscribe` stream on the Pump program: create / trade / complete events decoded with the official SDK IDL (≈30–45 trades/s observed)
- [x] Per-pool PumpSwap log subscriptions for tracked graduated tokens
- [x] PumpPortal free WebSocket (new tokens, migrations) as an independent source; optional API-key trade stream
- [x] DexScreener adapter (documented `/tokens/v1` endpoint, rate-limited)
- [x] On-chain reads: bonding curves, canonical PumpSwap pools (with fee buckets and virtual reserves), mint accounts (authorities, Token-2022 extensions, metadata), holders, creator activity
- [x] Reconciliation: timing-independent curve invariant check; quote-mint verification; migration detection
- [x] Provider health (ok/degraded/down), stale-data detection, RPC rate limiting, per-method cooldowns, backup-endpoint failover
- [x] Persistence of all SOL-quoted trades, 1-minute candles, mint/holder snapshots; retention policy

### Phase 3 — Analysis
- [x] Features over 1m/5m/15m/1h windows (no look-ahead), volatility, drawdown, acceleration, liquidity drain vs 5-minute high, manipulation heuristics, creator flows
- [x] Risk engine: 6 weighted categories, ~50 finding types each with source/timestamp/confidence, 12 critical flags, tiering, data confidence
- [x] Protocol-aware handling: non-SOL quotes, mayhem mode, migrating curves, Token-2022 extensions; protocol accounts excluded from concentration
- [x] Opportunity score (independent; cannot override critical flags)
- [x] Scenario-based profitability (bull/base/bear/rug) against constant-product reserves with impact, fees, latency drift and stop gaps
- [x] Strategies: momentum, volume acceleration, early launch (opt-in), pullback; shared exit policy; versioned configs with known-good revert

### Phase 4 — Paper trading
- [x] Risk manager: account gates, sizing (position %, hard caps, risk budget, impact-limited size, exposure, cash, allocation, tier and volatility scaling)
- [x] Order lifecycle with persistent idempotency keys and event history; execution-layer hard limits
- [x] Paper executor: fresh on-chain fill quote after latency, slippage failures, random tx failures (fee charged), stale quotes, route loss, blocked exits
- [x] Portfolio ledger: cash, positions, realized/unrealized (indicative vs executable), fees, daily start equity, peak/drawdown, losing streaks, per-strategy statistics
- [x] Emergency policy on loss/drawdown breach; persistent kill switch
- [x] Historical replay (point-in-time), metrics (net, win rate, PF, drawdown, Sharpe, fees, exposure, unexecutable exits, by strategy/tier/age/regime, quoted vs realized), in/out-of-sample split, optimizer producing reviewed proposals

### Phase 5 — Dashboard & API
- [x] Fastify API (validation, bearer auth, nonce/timestamp replay protection, rate limiting, strict CORS, correlation IDs, consistent errors, audit log)
- [x] WebSocket realtime stream (authenticated first message)
- [x] Dashboard: Overview, Token scanner (sort/filter, live updates), Token details (charts, risk breakdown, holders, creator, transactions, scenarios, history), Portfolio, Trade history (lifecycle), Strategy lab (backtests, proposals, parameters, versions), Risk controls (limits, kill switch, explicit live activation flow)

### Phase 6 — Live execution
- [x] Live executor using official SDK builders (curve buy/sell incl. Token-2022 coins and mayhem/cashback flags; PumpSwap buyQuoteInput/sellBaseInput)
- [x] Fresh quote + slippage re-check, simulation with wallet spend verification, signer transaction policy, signature persisted before broadcast, rebroadcast until blockhash expiry, settlement from confirmed balance deltas, ATA close on full exit
- [x] Live reconciler (unknown-outcome orders resolved from chain only; wallet vs ledger balance check)
- [x] Live activation: env gate + signer + paper-trade minimum + typed confirmation; disarmed after restart

### Phase 7 — Verification & deployment
- [x] 123 unit/API tests + 4 opt-in mainnet integration tests
- [x] CLI tools: migrate, kill-switch, wallet check, backtest
- [x] Dockerfile + docker-compose (loopback-published), systemd example, backup/restore/upgrade/rollback docs

## Verification log (this environment)

| Check | Result |
|---|---|
| `npm run build` (server + dashboard) | ✅ |
| `npm run typecheck` (server, web, tests) | ✅ |
| `npm run lint` | ✅ |
| `npm test` | ✅ 123 passed, 4 skipped (integration, opt-in) |
| `npm run test:integration` against mainnet | ✅ 4 passed (live log stream decode, curve reconciliation vs official SDK quotes, mint reads, DexScreener) |
| Server run against mainnet (paper mode) | ✅ ~42 trades/s ingested, hundreds of tokens tracked, all providers `ok`, curves reconciled every 4s |
| Dashboard rendered via headless Chromium | ✅ all pages, no console errors |
| End-to-end paper lifecycle on live mainnet data (separate instance, **deliberately permissive** EV thresholds for demonstration) | ✅ 7 entries filled against fresh on-chain reads; exits by stop (filled at −10.2% / −12.1% vs a 10% stop — stops gap), trailing stop, and risk escalation (`SEVERE_LIQUIDITY_DETERIORATION`, −41%); remaining positions valued at executable quotes. Closed trades were net negative, supporting the conservative defaults. One finding led to a fix: launch bursts were mistaken for volume acceleration (now requires a prior baseline). |
| CLI backtest on recorded mainnet data | ✅ runs; 0 trades at default thresholds over a short window (expected: conservative) |
| Docker image build | ⚠️ not verified (no Docker daemon in the build environment) |
| Live transaction submission | ⚠️ **not executed** (no funded wallet was used, by design). Instruction building uses the official SDK; signing policy, settlement and reconciliation are covered by unit tests with fakes. Do a small manual live test with a dedicated wallet before relying on it. |

### Real integrations vs fixtures
- **Verified against real services**: Solana mainnet RPC (HTTP + WebSocket), Pump program events, bonding-curve / PumpSwap pool / mint accounts, PumpPortal free WebSocket, DexScreener.
- **Tested with captured mainnet fixtures**: event decoding (`tests/fixtures/pump-logs.json`), curve math vs the SDK (`tests/fixtures/pump-accounts.json`).
- **Tested with fakes/mocks**: live executor outcomes (ambiguous / expired / settled), wallet reconciliation, RPC rate limits and failover.
- **Not verified**: PumpPortal per-token trade stream (needs a funded API key), live transaction landing.

## Findings during development (protocol reality checks)
- Many new Pump curves are quoted in assets other than SOL (PUMP, other pump coins, other tokens). PumpPortal reports "SOL" fields for them anyway, so on-chain quote verification is required. Such tokens are excluded.
- Mayhem-mode curves adjust virtual reserves outside of trades. This broke naive event/chain reconciliation, so they are handled as non-standard mechanics.
- The public RPC rate-limits `getTokenLargestAccounts` ("for a specific RPC call"). Holder data usually comes from the flow-based estimate unless a paid RPC is configured.
- PumpPortal's per-token trade stream requires a funded API key. The primary trade feed is therefore Solana RPC logs.

## Known limitations and risks
- **Risk scores and scenario probabilities are not calibrated.** Treat them as rankings. Calibrate with collected history (docs/RISK_MODEL.md §6).
- Default thresholds are conservative; in short sessions the bot may place no trades at all. This is intended. Loosening thresholds increases risk.
- Live execution has not been exercised with real funds in this environment.
- Holder concentration on public RPC is mostly estimated. Wallet-cluster detection is heuristic, with no funding-graph analysis.
- Creator reputation is limited to launches this installation observed.
- PumpSwap trade events lack virtual reserves. Pool pricing relies on 4-second on-chain refreshes (limited to priority and top tokens).
- Single-node SQLite design; PostgreSQL is not implemented.
- Backtests need recorded data. Default raw-trade retention is 48h, so increase it for longer studies.
- The dashboard uses one operator role (bearer token). There is no multi-user RBAC.

## Next steps
1. Run paper trading for several days and review realized vs quoted expectations by risk tier. Calibrate scenario probabilities and risk weights out of sample.
2. Add a paid RPC with `getTokenLargestAccounts` and `getProgramAccounts` support to enable true holder snapshots and the `early_launch` strategy.
3. Add funding-source clustering for creator/sniper wallets.
4. Do a supervised small-size live test with a dedicated wallet; verify settlement, ATA closing and reconciliation on-chain.
5. Optional: Jito bundle / priority-fee estimation, PostgreSQL adapter, multi-user auth.
