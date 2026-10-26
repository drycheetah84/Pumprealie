import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
  type SignatureStatus,
  type SimulatedTransactionResponse,
  type TokenAccountBalancePair,
  type VersionedTransaction,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import { errMsg, RateLimiter } from '../../lib/util';
import type { ProviderHealthMonitor } from '../providerHealth';

export class RpcRateLimitError extends Error {}

/**
 * Heavy enrichment methods that public endpoints often rate-limit. Their 429s mean the
 * enrichment is unavailable (recorded as missing data), not that the RPC is unhealthy.
 */
const OPTIONAL_METHODS = new Set(['getTokenLargestAccounts', 'getSignaturesForAddress']);

/**
 * Thin wrapper around web3.js `Connection` that adds: client-side rate limiting,
 * latency/health reporting, timeouts, and failover to an optional backup endpoint.
 * It never retries state-changing calls (sendRawTransaction) on its own.
 */
export class SolanaRpc {
  private readonly endpoints: Array<{ name: string; conn: Connection }>;
  private active = 0;
  private readonly limiter: RateLimiter;
  /** Per-method cooldowns after the endpoint rate-limits a specific (heavy) method. */
  private readonly blockedUntil = new Map<string, number>();
  readonly healthName = 'solana-rpc';

  constructor(
    urls: { primary: string; backup?: string },
    opts: { maxRps: number; timeoutMs: number; commitment?: Commitment },
    private readonly health: ProviderHealthMonitor,
    private readonly log: Logger,
  ) {
    const mk = (url: string) =>
      new Connection(url, {
        commitment: opts.commitment ?? 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) }),
      });
    this.endpoints = [{ name: 'primary', conn: mk(urls.primary) }];
    if (urls.backup) this.endpoints.push({ name: 'backup', conn: mk(urls.backup) });
    this.limiter = new RateLimiter(opts.maxRps, Math.max(2, Math.ceil(opts.maxRps)));
    health.register(this.healthName, { critical: true, downAfterMs: 60_000 });
  }

  get connection(): Connection {
    return this.endpoints[this.active]!.conn;
  }

  get endpointName(): string {
    return this.endpoints[this.active]!.name;
  }

  isCoolingDown(label: string): boolean {
    return (this.blockedUntil.get(label) ?? 0) > Date.now();
  }

  get queueDepth(): number {
    return this.limiter.pending;
  }

  /** Run a read-only call with rate limiting, health accounting and one failover attempt. */
  async call<T>(label: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    const blocked = this.blockedUntil.get(label) ?? 0;
    if (blocked > Date.now()) throw new RpcRateLimitError(`${label} cooling down after rate limit`);
    let lastErr: unknown;
    for (let attempt = 0; attempt < Math.min(2, this.endpoints.length); attempt++) {
      await this.limiter.acquire();
      const started = Date.now();
      try {
        const res = await fn(this.connection);
        this.health.success(this.healthName, Date.now() - started, `${this.endpointName} endpoint`);
        return res;
      } catch (e) {
        lastErr = e;
        const msg = errMsg(e);
        const rateLimited = /429|rate limit|Too many requests/i.test(msg);
        if (rateLimited && OPTIONAL_METHODS.has(label)) {
          this.blockedUntil.set(label, Date.now() + 120_000);
          this.health.setDetail(this.healthName, `${this.endpointName} endpoint; ${label} rate-limited (enrichment degraded)`);
          throw new RpcRateLimitError(msg);
        }
        this.health.failure(this.healthName, `${label}: ${msg}`);
        if (rateLimited) this.blockedUntil.set(label, Date.now() + (/specific RPC call/i.test(msg) ? 120_000 : 10_000));
        if (this.endpoints.length > 1) {
          this.active = (this.active + 1) % this.endpoints.length;
          this.log.warn({ label, err: msg, now: this.endpointName }, 'rpc call failed; switched endpoint');
        }
        if (rateLimited && this.endpoints.length === 1) throw new RpcRateLimitError(msg);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(errMsg(lastErr));
  }

  getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.call('getMultipleAccountsInfo', (c) => c.getMultipleAccountsInfo(keys));
  }

  getAccountInfo(key: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return this.call('getAccountInfo', (c) => c.getAccountInfo(key));
  }

  getTokenLargestAccounts(mint: PublicKey): Promise<TokenAccountBalancePair[]> {
    return this.call('getTokenLargestAccounts', async (c) => (await c.getTokenLargestAccounts(mint)).value);
  }

  getSignaturesForAddress(addr: PublicKey, limit: number): Promise<ConfirmedSignatureInfo[]> {
    return this.call('getSignaturesForAddress', (c) => c.getSignaturesForAddress(addr, { limit }));
  }

  getBalance(addr: PublicKey): Promise<number> {
    return this.call('getBalance', (c) => c.getBalance(addr));
  }

  getTokenAccountsByOwner(owner: PublicKey, programId: PublicKey) {
    return this.call('getTokenAccountsByOwner', async (c) => (await c.getTokenAccountsByOwner(owner, { programId })).value);
  }

  getLatestBlockhash() {
    return this.call('getLatestBlockhash', (c) => c.getLatestBlockhash('confirmed'));
  }

  getBlockHeight(): Promise<number> {
    return this.call('getBlockHeight', (c) => c.getBlockHeight('confirmed'));
  }

  getSlot(): Promise<number> {
    return this.call('getSlot', (c) => c.getSlot('confirmed'));
  }

  getSignatureStatuses(sigs: string[]): Promise<(SignatureStatus | null)[]> {
    return this.call('getSignatureStatuses', async (c) => (await c.getSignatureStatuses(sigs, { searchTransactionHistory: true })).value);
  }

  getParsedTransaction(sig: string): Promise<ParsedTransactionWithMeta | null> {
    return this.call('getParsedTransaction', (c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
  }

  simulate(tx: VersionedTransaction, accounts: PublicKey[]): Promise<SimulatedTransactionResponse> {
    return this.call('simulateTransaction', async (c) =>
      (
        await c.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: accounts.map((a) => a.toBase58()) },
        })
      ).value,
    );
  }

  /**
   * Broadcast a signed transaction. Not retried here: the caller owns the
   * blockhash-expiry based rebroadcast loop so duplicate submissions stay safe.
   */
  async sendRaw(raw: Uint8Array): Promise<string> {
    await this.limiter.acquire();
    return this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await this.getSlot();
    return Date.now() - t;
  }
}
