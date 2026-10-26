# Security

Pumpraelie can sign and send transactions that move real funds. This document covers how secrets are handled, what the software refuses to do, and how to deploy it safely.

## Principles

- **The wallet secret never leaves the trading machine.** It is not requested by the dashboard or API, not logged, not sent to any provider, and not included in any API response. The dashboard token is a separate credential with no signing power on its own.
- **Never enter a seed phrase anywhere in Pumpraelie.** No screen or endpoint asks for one. If something does, it is not this software.
- **Use a dedicated trading wallet** that holds only the capital you are prepared to lose. Never point Pumpraelie at your main wallet.
- **Fail closed.** Missing data, stale data, unhealthy providers, an unavailable database, a wallet/ledger mismatch or orders with unknown outcomes all block new entries.

## Wallet setup

Do this on the machine that runs Pumpraelie. Claude, the dashboard and the API never need to see the secret.

```bash
# 1. Create a dedicated keypair (do NOT reuse an existing wallet)
solana-keygen new --no-bip39-passphrase -o /secure/pumpraelie/trading-wallet.json
chmod 600 /secure/pumpraelie/trading-wallet.json
chown <service-user> /secure/pumpraelie/trading-wallet.json

# 2. Note the public key and fund it with only your trading capital + fee reserve
solana-keygen pubkey /secure/pumpraelie/trading-wallet.json

# 3. Configure (in .env, which is git-ignored)
WALLET_KEYPAIR_PATH=/secure/pumpraelie/trading-wallet.json
WALLET_PUBLIC_KEY=<the public key from step 2>   # refuses to start signing if the file changes

# 4. Verify without printing secrets
npm run wallet:check
```

The signer refuses to load a keypair file that is readable by group or others. If you need a hardware-backed or remote signer, implement the `TransactionSigner` interface (`src/server/execution/signer.ts`) and keep the same policy check in front of it.

## What the signer will and will not sign

Every transaction passes `enforceTradingPolicy` immediately before signing. It allows only:

- Compute-budget instructions, with the priority fee capped by `MAX_TX_FEE_SOL`.
- Exactly **one** Pump bonding-curve or PumpSwap trade instruction that references the intended mint.
- Creating associated token accounts that the wallet both pays for and owns.
- `SyncNative` and `CloseAccount` (rent goes back to the wallet) on token programs.
- System transfers **only into the wallet's own WSOL account**, within the order's spend limit.

Everything else is refused, including transfers to third parties, unknown programs and address lookup tables. Before signing, the transaction is also simulated, and the simulated drop in the wallet's SOL balance must stay within the order budget. There is no endpoint that signs arbitrary transactions.

## Dashboard and API

- Binds to `127.0.0.1` by default. Startup logs a warning if `API_HOST` is not a loopback address.
- All routes except `/api/health` require `Authorization: Bearer <DASHBOARD_API_TOKEN>`, compared in constant time. In production the token is required and must be at least 32 characters.
- State-changing commands also need a unique `x-request-nonce` and an `x-request-timestamp` within ±60s. Nonces are persisted, so a replayed command fails even after a restart.
- Every sensitive action (mode changes, live arming, kill switch, risk-limit edits, strategy changes, manual closes, write-offs, backtests, optimizer decisions) is written to the `audit_log` table with its correlation ID.
- Rate limiting is on (`API_RATE_LIMIT_PER_MIN`). CORS is off unless `CORS_ORIGINS` lists origins explicitly. Security headers are `nosniff`, `X-Frame-Options: DENY` and `no-referrer`.
- RPC URLs (which often contain API keys) are reduced to hostnames in API responses.
- The browser keeps the dashboard token in `sessionStorage` (cleared when the tab closes).

## Remote access

Do **not** expose port 8787 to the internet directly. If you need remote access:

1. Keep `API_HOST=127.0.0.1` (or publish the Docker port on `127.0.0.1` only, as the provided `docker-compose.yml` does).
2. Put an HTTPS reverse proxy in front (Caddy, nginx, Traefik) with its own authentication: SSO, mTLS or at least basic auth. Restrict source IPs with a firewall or VPN (WireGuard/Tailscale).
3. Set a long random `DASHBOARD_API_TOKEN` and `CORS_ORIGINS` to the proxy's origin only if the dashboard is served from another origin.
4. Proxy WebSockets for `/api/stream`.

## Live-trading safeguards

- `LIVE_TRADING_ENABLED=true` is a server-side gate. Without it, live cannot be armed.
- Arming needs a loaded signer, at least `MIN_PAPER_TRADES_FOR_LIVE` closed paper trades, no active kill switch, and typing a wallet-specific phrase within 2 minutes. The dialog shows the wallet, mode and all limits first.
- The armed state is never restored after a restart.
- Hard limits (`HARD_MAX_POSITION_SOL`, `HARD_MAX_*`) are enforced in the execution layer independently of the risk manager, and the dashboard cannot raise them.
- The kill switch is persisted (committed to SQLite) before the API acknowledges it, and survives restarts. `npm run kill-switch -- on` works while the server is down.

## Reporting

If you find a vulnerability, do not open a public issue with exploit details. Contact the repository owner privately.
