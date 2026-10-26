# Pumpraelie

Pumpraelie is a risk-first trading agent for [Pump.fun](https://pump.fun) tokens on Solana. It watches every Pump bonding-curve trade on-chain and checks token state against the chain. For each candidate it estimates rug-pull risk and the profit left after realistic execution costs. It then decides to buy, sell, hold, reduce or skip, under hard risk limits.

It is built to **do nothing unless a trade is worth its risk after fees, price impact, latency and the chance of not being able to exit**. It does not chase trade count or paper profit.

> **Read this first.** Pumpraelie can lose money, and with live trading enabled it trades real funds. Its risk score is a heuristic ranking, **not** a probability of a rug pull. Some scams cannot be detected before they happen. Live trading is off by default and needs several deliberate steps to enable (see [Enabling live trading](#enabling-live-trading)).

---

## What it does

| Area | Implementation |
|---|---|
| **Market data** | Solana RPC `logsSubscribe` on the Pump program decodes every create, trade and complete (graduation) event using the official `@pump-fun/pump-sdk` IDL decoders. That is about 30–45 trades/s. The bot also subscribes per pool to PumpSwap pools it tracks. **PumpPortal** (free tier) is a second, independent source for launches and migrations. **DexScreener** provides aggregate stats for graduated tokens. |
| **On-chain reconciliation** | Bonding curves, PumpSwap pools and mint accounts are batch-read every 4s for active tokens. Streamed state is checked against the chain with a timing-independent curve invariant (constant product plus virtual−real offsets). Disagreement raises `DATA_INCONSISTENT`. |
| **Protocol awareness** | SOL-quoted curves and canonical SOL PumpSwap pools are tradable. Curves quoted in other assets (PUMP, USDC, other pump coins…) are tracked but marked `UNSUPPORTED_QUOTE_ASSET`. Mayhem-mode curves get `NONSTANDARD_MECHANICS`. Token-2022 extensions, mint and freeze authorities are evaluated per token program. |
| **Token intelligence** | Price, market cap (with its method), liquidity, curve progress, volume and buy/sell counts over 1m/5m/15m/1h, momentum, volatility, drawdown, volume acceleration, holder concentration (protocol accounts excluded), creator behaviour, manipulation heuristics, and an exit-impact simulation. |
| **Risk engine** | Six weighted categories (liquidity/exit 25%, holders 20%, creator 20%, trading anomalies 15%, permissions 10%, data reliability 10%), plus independent **critical flags** that always block entries. See [docs/RISK_MODEL.md](docs/RISK_MODEL.md). |
| **Profitability** | Bull, base, bear and rug scenarios are simulated against the constant-product reserves, including our own price impact, protocol fees, network and priority fees, latency drift and stop gaps. |
| **Strategies** | Momentum continuation, volume acceleration, early-launch evaluation (opt-in, stricter) and pullback entry, plus a shared exit and position-protection policy. See [docs/STRATEGIES.md](docs/STRATEGIES.md). |
| **Risk manager** | All sizing and gating happens here: 1% position, 10% exposure, 3% daily loss, 5% drawdown, losing streaks, data freshness, provider health and reconciliation. Hard limits are enforced again in the execution layer. |
| **Execution** | Explicit order lifecycle `CREATED → VALIDATED → SUBMITTED → CONFIRMED → SETTLED`, with `FAILED / EXPIRED / REJECTED / CANCELLED / RECONCILING`. Persistent idempotency keys and unique DB constraints prevent duplicate orders. |
| **Paper trading** | Fills are simulated against a fresh on-chain read after a configurable latency, so the market can move against the order. Includes slippage failures, random transaction failures (fee still charged), stale quotes and blocked exits. The paper executor has no RPC or signer dependency, so it cannot send transactions. |
| **Live trading** | Uses official SDK builders for curve `buy`/`sell` and PumpSwap swaps. Each trade gets a fresh quote and is simulated with a wallet spend check. The signer applies a policy that only accepts its own trade shapes. The signature is persisted before broadcast. The bot rebroadcasts until blockhash expiry and settles from the confirmed transaction's balance changes. Open orders are reconciled from the chain after a restart. |
| **Backtesting** | Event-driven replay of recorded on-chain trades with no look-ahead (point-in-time snapshots only). Uses the same strategies, risk manager and liquidity math, with an in-sample/out-of-sample split and survivorship-free data (dead tokens are included). The optimizer only *proposes* strategy-parameter changes. |
| **Dashboard** | React app, dark terminal theme: Overview, Token scanner, Token details, Portfolio, Trade history, Strategy lab and Risk controls, with real-time WebSocket updates. |

## Requirements

- Node.js ≥ 22, npm. The `better-sqlite3` native module builds automatically. On Linux you may need `python3 make g++`.
- Network access to a Solana RPC (HTTP + WebSocket). The public endpoint works for paper trading.

## Quick start (paper trading)

```bash
npm install
cp .env.example .env          # optional — defaults are paper trading on the public RPC
npm run build                 # compiles the server and the dashboard
npm run migrate               # creates ./data/pumpraelie.db (also runs automatically at startup)
npm start                     # http://127.0.0.1:8787
```

In development, if `DASHBOARD_API_TOKEN` is unset, a random token is written to `./data/dashboard-token` (mode 0600) and its path is logged. Sign in to the dashboard with that token.

Development with hot reload:

```bash
npm run dev        # API + engine (tsx watch) on :8787
npm run dev:web    # Vite dev server on :5173, proxying /api to :8787
```

### Running paper trading

Paper trading is the default mode (`TRADING_MODE=paper`). Once started:

1. The engine collects live market data and assesses active tokens every `EVALUATION_INTERVAL_MS`.
2. Entries happen only when a strategy signals **and** every risk gate passes **and** scenario-weighted expected net return ≥ `MIN_EXPECTED_NET_RETURN_PCT` **and** reward/risk ≥ `MIN_REWARD_TO_RISK`. With the conservative defaults, entries are rare. That is expected.
3. Watch **Token scanner** for recommendations and their reasons, **Portfolio** for positions (indicative and executable values side by side) and **Trade history** for the full order lifecycle.
4. Every SOL-quoted trade is recorded (`RECORD_ALL_TRADES=true`) for backtesting. Run backtests from **Strategy lab** or `npm run backtest -- --train 0.7`.

Switch to **Offline** mode on the Risk controls page to run analysis without placing any orders.

## Enabling live trading

Live trading is implemented but disabled by default. All of the following are required:

1. Create a **dedicated** trading wallet and fund it only with the capital you intend to risk (see [SECURITY.md](SECURITY.md#wallet-setup)). Never use your main wallet.
2. Set `WALLET_KEYPAIR_PATH` (file mode `0600`), optionally `WALLET_PUBLIC_KEY`, and `LIVE_TRADING_ENABLED=true`. Use a reliable paid RPC for `SOLANA_RPC_URL`.
3. Run `npm run wallet:check`. It verifies file permissions and prints the public key and balance, never the secret.
4. Complete at least `MIN_PAPER_TRADES_FOR_LIVE` closed paper trades (default 20) and review the results.
5. On **Risk controls**, click **Enable live trading…**. The dialog shows the wallet, mode and every risk limit. Type the confirmation phrase within 2 minutes.

After a restart, live mode is **disarmed** until you confirm again. Exits and reconciliation for existing live positions keep running. **Emergency stop** (top bar) or `npm run kill-switch -- on "reason"` blocks all new entries immediately and persistently.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile server (`dist/server`) and dashboard (`dist/web`) |
| `npm start` | Run the compiled server |
| `npm run dev` / `npm run dev:web` | Development servers |
| `npm test` | Unit + API tests (fixtures captured from mainnet; no network) |
| `npm run test:integration` | Read-only integration tests against Solana mainnet and DexScreener |
| `npm run typecheck` / `npm run lint` | TypeScript (server, web, tests) and ESLint |
| `npm run migrate` | Apply database migrations |
| `npm run kill-switch -- status\|on "reason"\|off` | Operate the persistent kill switch without the dashboard |
| `npm run wallet:check` | Verify wallet configuration (no secrets printed) |
| `npm run backtest -- [--train 0.7] [--strategies momentum] [--hours 24] [--seed 42]` | Historical replay from the CLI |

## Configuration

All variables are documented in [.env.example](.env.example). None are strictly required for paper trading. Required for production/live:

| Variable | When | How to obtain |
|---|---|---|
| `DASHBOARD_API_TOKEN` | `APP_ENV=production` | `openssl rand -base64 36` |
| `SOLANA_RPC_URL` (+ `SOLANA_WS_URL`) | strongly recommended for live | A Solana RPC provider account (Helius, Triton, QuickNode, …); the URL usually contains your API key |
| `WALLET_KEYPAIR_PATH`, `LIVE_TRADING_ENABLED=true` | live trading | `solana-keygen new -o <path>` on the trading machine (see SECURITY.md) |
| `PUMPPORTAL_API_KEY` | optional | pumpportal.fun; enables a redundant per-token trade stream |

Runtime risk controls (Risk controls page / `PUT /api/risk-controls`) are persisted and clamped to the `HARD_*` limits. Every change is audit-logged.

## Architecture

```
src/
  shared/types.ts            domain types shared by server and dashboard
  server/
    config/                  env schema (zod), risk settings + hard limits
    db/                      SQLite (WAL), migrations, persistence
    market/                  providers (RPC logs, RPC reads, PumpPortal, DexScreener),
                             token registry, liquidity math, market engine, provider health
    analysis/                features, risk engine, opportunity, profitability, assessment
    strategy/                strategy interface, 4 entry strategies, exit policy, versioned configs
    risk/                    risk manager (gates + sizing)
    portfolio/               ledger, positions, P&L, equity, statistics
    execution/               order repo, paper/live executors, signer policy, reconciliation
    engine/                  trading loop, mode controller (live activation)
    backtest/                replay engine, metrics, backtest service, optimizer
    api/                     Fastify server, auth, routes, realtime WebSocket
    cli/                     migrate, kill-switch, wallet check, backtest
  web/                       React dashboard (Vite)
tests/                       unit, API, integration (mainnet, opt-in), fixtures
```

Documentation: [docs/RISK_MODEL.md](docs/RISK_MODEL.md) · [docs/STRATEGIES.md](docs/STRATEGIES.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) (deployment, backups, recovery) · [SECURITY.md](SECURITY.md) · [PROGRESS.md](PROGRESS.md)

## API

All `/api/*` routes except `/api/health` need `Authorization: Bearer <DASHBOARD_API_TOKEN>`. State-changing commands also need `x-request-nonce` (unique, 16–128 chars) and `x-request-timestamp` (ms, within ±60s), which protects against replayed commands. Errors look like `{ error: { code, message }, correlationId }`, and every response carries `x-correlation-id`.

| Method & path | Description |
|---|---|
| `GET /api/health` | Public liveness/readiness (`ok` / `degraded` / `down`) |
| `GET /api/status` | Mode, kill switch, entry blockers, providers, stream statistics |
| `GET /api/tokens` | Scanner (`sort`, `dir`, `maxRisk`, `minLiquidity`, `minMomentum`, `maxAgeMin`, `strategy`, `action`, `q`) |
| `GET /api/tokens/:mint` | Full assessment, candles, liquidity history, trades, decisions, orders |
| `GET /api/risk`, `GET/PUT /api/risk-controls` | Risk model, settings, hard limits |
| `GET /api/portfolio`, `GET /api/positions` | Summary, equity history, positions |
| `POST /api/positions/:id/close`, `POST /api/positions/:id/write-off` | Manual exit / write-off of a stuck position |
| `GET /api/trades`, `GET /api/trades/:id` | Orders with lifecycle events |
| `GET /api/strategies`, `PUT /api/strategies/:id/params`, `POST …/known-good`, `POST …/revert`, `POST …/optimize` | Strategy lab |
| `GET/POST /api/backtests`, `GET /api/backtests/:id`, `GET /api/proposals`, `POST /api/proposals/:id/decision` | Backtesting and optimizer proposals |
| `POST /api/emergency/stop`, `POST /api/emergency/clear` | Kill switch |
| `POST /api/mode`, `POST /api/mode/live/prepare`, `POST /api/mode/live/confirm`, `POST /api/mode/live/disarm` | Trading mode |
| `GET /api/alerts`, `GET /api/audit`, `GET /api/settings` | Alerts, audit log, non-secret settings |
| `WS /api/stream` | Realtime: send `{"type":"auth","token":"…"}` first. Pushes `tokens`, `order`, `position`, `alert`, `status`, `portfolio` |

## Known limitations

See [PROGRESS.md](PROGRESS.md#known-limitations-and-risks).
