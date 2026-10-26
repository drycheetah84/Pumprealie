/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped;
 * add a new one instead. Each migration runs inside a transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE tokens (
  mint TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  creator TEXT,
  created_at INTEGER,
  create_signature TEXT,
  token_program TEXT,
  quote_mint TEXT,
  is_mayhem INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL DEFAULT 'bonding_curve',
  complete INTEGER NOT NULL DEFAULT 0,
  graduated_at INTEGER,
  pool TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX idx_tokens_creator ON tokens(creator);
CREATE INDEX idx_tokens_last_seen ON tokens(last_seen_at);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER,
  ts INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  sol_lamports INTEGER NOT NULL,
  token_amount TEXT NOT NULL,
  trader TEXT NOT NULL,
  venue TEXT NOT NULL,
  v_sol INTEGER,
  v_token TEXT,
  real_sol INTEGER,
  real_token TEXT,
  fee_lamports INTEGER,
  source TEXT NOT NULL,
  UNIQUE(signature, event_index)
);
CREATE INDEX idx_trades_mint_ts ON trades(mint, ts);
CREATE INDEX idx_trades_ts ON trades(ts);

CREATE TABLE candles (
  mint TEXT NOT NULL,
  minute INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume_sol REAL NOT NULL,
  buys INTEGER NOT NULL,
  sells INTEGER NOT NULL,
  real_sol REAL,
  PRIMARY KEY (mint, minute)
);
CREATE INDEX idx_candles_minute ON candles(minute);

CREATE TABLE token_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX idx_snapshots_mint_kind ON token_snapshots(mint, kind, observed_at);

CREATE TABLE assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  assessed_at INTEGER NOT NULL,
  risk_score REAL,
  tier TEXT,
  action TEXT NOT NULL,
  strategy TEXT,
  expected_net_pct REAL,
  data TEXT NOT NULL
);
CREATE INDEX idx_assessments_mint ON assessments(mint, assessed_at);
CREATE INDEX idx_assessments_at ON assessments(assessed_at);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  strategy TEXT,
  action TEXT NOT NULL,
  approved INTEGER NOT NULL,
  size_sol REAL,
  reasons TEXT NOT NULL,
  assessment_id INTEGER REFERENCES assessments(id) ON DELETE SET NULL
);
CREATE INDEX idx_decisions_mint ON decisions(mint, decided_at);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closing','closed','stuck')),
  venue TEXT NOT NULL,
  token_amount_raw TEXT NOT NULL,
  cost_basis_sol REAL NOT NULL,
  entry_price_sol REAL NOT NULL,
  entry_at INTEGER NOT NULL,
  exit_at INTEGER,
  realized_pnl_sol REAL NOT NULL DEFAULT 0,
  proceeds_sol REAL NOT NULL DEFAULT 0,
  fees_sol REAL NOT NULL DEFAULT 0,
  peak_value_sol REAL NOT NULL DEFAULT 0,
  stop_pct REAL NOT NULL,
  target_pct REAL NOT NULL,
  max_hold_sec INTEGER NOT NULL,
  last_indicative_value_sol REAL,
  last_executable_value_sol REAL,
  last_valuation_at INTEGER,
  close_reason TEXT,
  meta TEXT
);
CREATE UNIQUE INDEX uq_positions_active_mint ON positions(mode, mint) WHERE status IN ('open','closing','stuck');
CREATE INDEX idx_positions_mode_status ON positions(mode, status);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  venue TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_sol REAL,
  requested_tokens_raw TEXT,
  max_slippage_pct REAL NOT NULL,
  quoted_tokens_raw TEXT,
  quoted_sol REAL,
  filled_tokens_raw TEXT,
  filled_sol REAL,
  fee_sol REAL,
  signature TEXT,
  last_valid_block_height INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  reason TEXT NOT NULL,
  position_id INTEGER REFERENCES positions(id),
  decision_id INTEGER REFERENCES decisions(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_orders_active ON orders(mode, mint, side)
  WHERE status IN ('CREATED','VALIDATED','SUBMITTED','CONFIRMED','RECONCILING');
CREATE UNIQUE INDEX uq_orders_signature ON orders(signature) WHERE signature IS NOT NULL;
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  at INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  position_id INTEGER REFERENCES positions(id),
  note TEXT
);
CREATE INDEX idx_ledger_mode ON ledger(mode, at);

CREATE TABLE equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  at INTEGER NOT NULL,
  equity_sol REAL NOT NULL,
  cash_sol REAL NOT NULL,
  indicative_sol REAL NOT NULL,
  executable_sol REAL NOT NULL,
  exposure_sol REAL NOT NULL,
  drawdown_pct REAL NOT NULL
);
CREATE INDEX idx_equity_mode_at ON equity_snapshots(mode, at);

CREATE TABLE daily_stats (
  mode TEXT NOT NULL,
  day TEXT NOT NULL,
  start_equity_sol REAL NOT NULL,
  PRIMARY KEY (mode, day)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  correlation_id TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

CREATE TABLE command_nonces (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE provider_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  latency_ms REAL,
  detail TEXT
);
CREATE INDEX idx_provider_health_at ON provider_health(at);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  mint TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_alerts_at ON alerts(created_at);

CREATE TABLE creators (
  address TEXT PRIMARY KEY,
  launches INTEGER NOT NULL DEFAULT 0,
  graduated INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  params TEXT NOT NULL,
  results TEXT,
  error TEXT
);

CREATE TABLE strategy_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  known_good INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE(strategy, version)
);

CREATE TABLE config_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  current_config TEXT NOT NULL,
  proposed_config TEXT NOT NULL,
  evaluation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
  decided_at INTEGER,
  decided_by TEXT,
  note TEXT
);
`,
  },
];
