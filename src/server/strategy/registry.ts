import { json, type DB } from '../db/database';
import { ENTRY_STRATEGIES } from './strategies';
import { defaultsOf, validateParams, type Strategy, type StrategyParams } from './types';

export interface StrategyConfigVersion {
  id: number;
  strategy: string;
  version: number;
  config: StrategyParams;
  createdAt: number;
  createdBy: string;
  active: boolean;
  knownGood: boolean;
  note: string | null;
}

/**
 * Versioned strategy parameters. Every change creates a new version; nothing is
 * overwritten, so any previous (or known-good) configuration can be restored.
 * Strategy parameters never include safety limits — those live in risk settings.
 */
export class StrategyRegistry {
  private cache = new Map<string, StrategyParams>();
  readonly strategies: Strategy[];

  constructor(private readonly db: DB, strategies: Strategy[] = ENTRY_STRATEGIES) {
    this.strategies = strategies;
    for (const s of strategies) {
      const active = this.active(s.id);
      if (!active) this.save(s.id, defaultsOf(s.paramSpecs), 'system', 'initial defaults', true);
    }
  }

  get(id: string): Strategy | undefined {
    return this.strategies.find((s) => s.id === id);
  }

  params(id: string): StrategyParams {
    const c = this.cache.get(id);
    if (c) return c;
    const a = this.active(id);
    const s = this.get(id)!;
    const p = a ? validateParams(s.paramSpecs, { ...defaultsOf(s.paramSpecs), ...filterKnown(s, a.config) }).params : defaultsOf(s.paramSpecs);
    this.cache.set(id, p);
    return p;
  }

  private active(id: string): StrategyConfigVersion | null {
    const r = this.db.prepare('SELECT * FROM strategy_configs WHERE strategy = ? AND active = 1 ORDER BY version DESC LIMIT 1').get(id) as Record<string, unknown> | undefined;
    return r ? rowToVersion(r) : null;
  }

  history(id: string): StrategyConfigVersion[] {
    return (this.db.prepare('SELECT * FROM strategy_configs WHERE strategy = ? ORDER BY version DESC LIMIT 50').all(id) as Record<string, unknown>[]).map(rowToVersion);
  }

  save(id: string, params: StrategyParams, by: string, note: string, knownGood = false): StrategyConfigVersion {
    const s = this.get(id);
    if (!s) throw new Error(`unknown strategy ${id}`);
    const v = validateParams(s.paramSpecs, params);
    if (!v.ok) throw new Error(`invalid parameters: ${v.errors.join('; ')}`);
    const next = ((this.db.prepare('SELECT MAX(version) AS v FROM strategy_configs WHERE strategy = ?').get(id) as { v: number | null }).v ?? 0) + 1;
    this.db.transaction(() => {
      this.db.prepare('UPDATE strategy_configs SET active = 0 WHERE strategy = ?').run(id);
      this.db
        .prepare('INSERT INTO strategy_configs (strategy, version, config, created_at, created_by, active, known_good, note) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(id, next, json.str(v.params), Date.now(), by, knownGood ? 1 : 0, note);
    })();
    this.cache.delete(id);
    return this.active(id)!;
  }

  markKnownGood(id: string): void {
    this.db.prepare('UPDATE strategy_configs SET known_good = 1 WHERE strategy = ? AND active = 1').run(id);
  }

  revertToKnownGood(id: string, by: string): StrategyConfigVersion {
    const r = this.db
      .prepare('SELECT * FROM strategy_configs WHERE strategy = ? AND known_good = 1 ORDER BY version DESC LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) throw new Error(`no known-good configuration for ${id}`);
    const v = rowToVersion(r);
    return this.save(id, v.config, by, `revert to known-good v${v.version}`, true);
  }
}

function filterKnown(s: Strategy, p: StrategyParams): StrategyParams {
  return Object.fromEntries(Object.entries(p).filter(([k]) => k in s.paramSpecs));
}

function rowToVersion(r: Record<string, unknown>): StrategyConfigVersion {
  return {
    id: r.id as number,
    strategy: r.strategy as string,
    version: r.version as number,
    config: json.parse(r.config as string, {}),
    createdAt: r.created_at as number,
    createdBy: r.created_by as string,
    active: Boolean(r.active),
    knownGood: Boolean(r.known_good),
    note: (r.note as string | null) ?? null,
  };
}
