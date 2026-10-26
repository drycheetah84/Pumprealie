import type { ProviderHealth } from '../../shared/types';

/**
 * Tracks success/failure of each data provider. Status rules:
 * - `down`: last success older than `downAfterMs`, or never succeeded after `downAfterMs` since registration
 * - `degraded`: recent error within `degradeWindowMs`, or error ratio above threshold
 * - `ok` otherwise
 */
export class ProviderHealthMonitor {
  private entries = new Map<
    string,
    {
      registeredAt: number;
      enabled: boolean;
      critical: boolean;
      downAfterMs: number;
      lastSuccessAt: number | null;
      lastErrorAt: number | null;
      lastError: string | null;
      latencyMs: number | null;
      recent: Array<{ at: number; ok: boolean }>;
      detail: string;
    }
  >();

  constructor(private readonly clock: () => number = Date.now) {}

  register(name: string, opts: { enabled?: boolean; critical?: boolean; downAfterMs?: number } = {}) {
    this.entries.set(name, {
      registeredAt: this.clock(),
      enabled: opts.enabled ?? true,
      critical: opts.critical ?? false,
      downAfterMs: opts.downAfterMs ?? 60_000,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      latencyMs: null,
      recent: [],
      detail: '',
    });
  }

  success(name: string, latencyMs: number | null = null, detail?: string) {
    const e = this.entries.get(name);
    if (!e) return;
    const t = this.clock();
    e.lastSuccessAt = t;
    if (latencyMs !== null) e.latencyMs = e.latencyMs === null ? latencyMs : e.latencyMs * 0.8 + latencyMs * 0.2;
    if (detail !== undefined) e.detail = detail;
    this.push(e, t, true);
  }

  failure(name: string, error: string) {
    const e = this.entries.get(name);
    if (!e) return;
    const t = this.clock();
    e.lastErrorAt = t;
    e.lastError = error.slice(0, 300);
    this.push(e, t, false);
  }

  setDetail(name: string, detail: string) {
    const e = this.entries.get(name);
    if (e) e.detail = detail;
  }

  private push(e: { recent: Array<{ at: number; ok: boolean }> }, at: number, ok: boolean) {
    e.recent.push({ at, ok });
    if (e.recent.length > 50) e.recent.shift();
  }

  get(name: string): ProviderHealth | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const t = this.clock();
    let status: ProviderHealth['status'] = 'ok';
    if (!e.enabled) status = 'disabled';
    else {
      const since = e.lastSuccessAt ?? e.registeredAt;
      const recent = e.recent.filter((r) => t - r.at < 120_000);
      const errRatio = recent.length ? recent.filter((r) => !r.ok).length / recent.length : 0;
      if (t - since > e.downAfterMs) status = 'down';
      else if (e.lastSuccessAt === null) status = 'degraded';
      else if (errRatio > 0.3 || (e.lastErrorAt !== null && t - e.lastErrorAt < 15_000 && errRatio > 0)) status = 'degraded';
    }
    return {
      name,
      status,
      lastSuccessAt: e.lastSuccessAt,
      lastErrorAt: e.lastErrorAt,
      lastError: e.lastError,
      latencyMs: e.latencyMs === null ? null : Math.round(e.latencyMs),
      detail: e.detail,
    };
  }

  all(): ProviderHealth[] {
    return [...this.entries.keys()].map((n) => this.get(n)!).filter(Boolean);
  }

  /** Names of critical providers that are not `ok`. */
  criticalProblems(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.critical && e.enabled)
      .map(([n]) => this.get(n)!)
      .filter((h) => h.status !== 'ok')
      .map((h) => `${h.name} ${h.status}`);
  }
}
