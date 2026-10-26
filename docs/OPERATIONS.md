# Operations: deployment, monitoring, backup and recovery

## Local development

```bash
npm install
npm run dev          # API + trading engine with reload (http://127.0.0.1:8787)
npm run dev:web      # dashboard with HMR (http://127.0.0.1:5173, proxies /api)
npm test             # unit + API tests
npm run lint && npm run typecheck
```

## Production (bare metal / VM)

```bash
npm ci
npm run build
cp .env.example .env   # set APP_ENV=production, DASHBOARD_API_TOKEN, SOLANA_RPC_URL, …
npm run migrate
npm start              # or run under systemd (below)
```

Example systemd unit (`/etc/systemd/system/pumpraelie.service`):

```ini
[Unit]
Description=Pumpraelie
After=network-online.target

[Service]
User=pumpraelie
WorkingDirectory=/opt/pumpraelie
EnvironmentFile=/opt/pumpraelie/.env
ExecStart=/usr/bin/node dist/server/server/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/pumpraelie/data

[Install]
WantedBy=multi-user.target
```

## Docker Compose

```bash
cp .env.example .env    # set DASHBOARD_API_TOKEN (required in production)
docker compose up -d --build
docker compose logs -f
```

- Data is kept in the `pumpraelie-data` volume (`/data`: database, logs).
- The port is published on `127.0.0.1:8787` only.
- The container health check calls `/api/health`.
- To enable live trading, mount the keypair read-only (see the commented lines in `docker-compose.yml`) and set `WALLET_KEYPAIR_PATH`.

## Health and monitoring

- `GET /api/health` (no auth): `ok` / `degraded` / `down`, DB status, critical provider problems. It returns 503 if the database is unavailable.
- `GET /api/status` (auth): provider details, stream rates, reconnect counts, entry blockers, reconciliation state.
- Logs are structured JSON (pino) on stdout and in `LOG_FILE` if set. Secrets are redacted by path (`secretKey`, `privateKey`, `seed`, `mnemonic`, `authorization`, `apiKey`, …).
- Alerts (dashboard, `alerts` table) cover kill switch, limit breaches, difficult exits, missing exit quotes, ledger mismatches, live arming and restarts in live mode.
- Provider health snapshots are stored in `provider_health` (kept for 7 days).

## Graceful shutdown

On SIGTERM/SIGINT: the API stops accepting requests, the trading loop finishes its current tick and waits for in-flight orders (up to 10s), buffered trades are flushed, and the database is closed. Shutdown is forced after 20s.

## Restart recovery

- **Paper**: fills are atomic SQLite transactions, so an order left non-terminal by a crash never produced a fill. It is marked FAILED/CANCELLED at startup and positions return to `open`.
- **Live**: the signature and blockhash expiry height are persisted **before** broadcast. After a restart the live reconciler:
  1. moves SUBMITTED/CONFIRMED orders to RECONCILING;
  2. queries signature status, settles confirmed transactions from their actual balance changes, marks transactions EXPIRED once the blockhash expired without landing, and never resubmits;
  3. compares wallet token balances to open positions and blocks entries on any mismatch until resolved.
- Open positions are re-pinned so their markets are monitored immediately.
- Live mode comes back **disarmed**. The kill switch keeps its persisted state.

## Emergency procedures

| Situation | Action |
|---|---|
| Something looks wrong | Dashboard **Emergency stop**, or `npm run kill-switch -- on "reason"` (works with the server down). New entries are blocked; exits continue. |
| Loss/drawdown limit hit | Automatic: entries suspended, pending entries cancelled, policy `reduce` exits positions while quotes are executable (`hold` only stops entries). |
| RPC/stream outage | Automatic: stale data / unhealthy providers block entries. Positions without a fresh executable quote are **held** (no blind sells) and alerted. Configure `SOLANA_RPC_BACKUP_URL` for failover. |
| Position cannot be sold | Marked `stuck` after 3 failed exits; retried every minute; critical alert. If the token is truly unsellable, use **Write off** (records the loss, moves nothing). |
| Wallet/ledger mismatch | Entries blocked. Check the wallet on an explorer, check for manual transfers, and resolve orders in RECONCILING. The flag clears automatically once balances agree. |

## Backups

SQLite runs in WAL mode. Take consistent online backups with the SQLite backup API:

```bash
sqlite3 data/pumpraelie.db ".backup 'backups/pumpraelie-$(date +%F-%H%M).db'"
# or, without the sqlite3 CLI:
node -e "require('better-sqlite3')('data/pumpraelie.db').backup('backups/pumpraelie-'+Date.now()+'.db').then(()=>console.log('ok'))"
```

Back up at least daily, and before every upgrade. The keypair file is **not** in the data directory. Back it up separately, offline and encrypted.

**Restore**: stop the service, replace `data/pumpraelie.db` (and delete any `-wal`/`-shm` files next to it), start the service. Migrations run automatically. After restoring an older backup in live mode, expect a wallet/ledger mismatch: reconcile before clearing.

## Data retention

An hourly job deletes raw trades older than `RETENTION_RAW_TRADES_HOURS` (default 48h). It also removes candles and snapshots older than `RETENTION_CANDLES_DAYS`, assessments older than `RETENTION_ASSESSMENTS_DAYS` (except those referenced by approved decisions), provider-health history older than 7 days, and command nonces older than 24h. At current Pump volume (≈35 trades/s), raw trades are the largest table, roughly 0.5–1 GB/day.

## Upgrades and rollback

1. `npm run kill-switch -- on "upgrade"` (or ensure no orders are in flight), then back up the database.
2. `git pull && npm ci && npm run build && npm run migrate`, then restart.
3. Check `/api/health`, review alerts, then clear the kill switch.

Rollback: stop, check out the previous version, restore the pre-upgrade database backup (migrations are forward-only), rebuild, start.

## PostgreSQL

SQLite (WAL) was chosen because Pumpraelie is a single-node, single-writer service and needs strong local transactional guarantees (unique constraints for idempotency, atomic fill settlement) with no extra infrastructure. Migrations are plain ordered SQL in `src/server/db/migrations.ts`. Porting to PostgreSQL would mean replacing `better-sqlite3` calls (synchronous transactions) with a pooled async client, and converting partial unique indexes and the `AUTOINCREMENT` columns. This is not implemented.
