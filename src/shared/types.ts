// Domain types shared by the backend and the dashboard.
// All SOL amounts in these types are expressed in SOL (floating point) unless the
// field name ends in `Lamports`; raw token amounts are decimal strings in base units.

export type TradingMode = 'offline' | 'paper' | 'live';
export type Venue = 'bonding_curve' | 'pumpswap' | 'unknown';
export type Side = 'buy' | 'sell';

export type RiskTier = 'lower' | 'moderate' | 'high' | 'very_high' | 'extreme';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type RecommendedAction = 'buy' | 'skip' | 'watch' | 'hold' | 'reduce' | 'sell';

export type RiskCategory =
  | 'liquidity_exit'
  | 'holder_concentration'
  | 'creator_wallet'
  | 'trading_anomalies'
  | 'permissions_mechanics'
  | 'data_reliability';

export type CriticalFlag =
  | 'EXIT_ROUTE_UNAVAILABLE'
  | 'UNSUPPORTED_QUOTE_ASSET'
  | 'SEVERE_LIQUIDITY_DETERIORATION'
  | 'TRANSFER_RESTRICTION'
  | 'MINT_AUTHORITY_ACTIVE'
  | 'EXTREME_EXIT_IMPACT'
  | 'CRITICAL_DATA_MISSING'
  | 'DATA_STALE'
  | 'DATA_INCONSISTENT'
  | 'CREATOR_DUMPING'
  | 'MIGRATION_IN_PROGRESS';

/** One piece of evidence behind a risk or opportunity judgement. */
export interface Finding {
  code: string;
  category: RiskCategory | 'opportunity';
  severity: Severity;
  message: string;
  /** Points this finding contributed to its category score (0-100 scale). */
  points: number;
  source: string;
  observedAt: number;
  /** 0..1, how much the finding should be trusted. */
  confidence: number;
}

export interface CategoryScore {
  category: RiskCategory;
  score: number;
  weight: number;
  findings: Finding[];
}

export interface RiskAssessment {
  score: number;
  tier: RiskTier;
  categories: CategoryScore[];
  criticalFlags: CriticalFlag[];
  /** 0..1 overall confidence in the data used. */
  dataConfidence: number;
  missing: string[];
  /** Explicit reminder that this is a heuristic score, not a calibrated probability. */
  calibrated: false;
}

export interface WindowStats {
  windowSec: number;
  volumeSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buys: number;
  sells: number;
  uniqueTraders: number;
  priceChangePct: number | null;
}

export interface MarketFeatures {
  asOf: number;
  priceSol: number | null;
  /** Price in SOL per whole token (6 decimals assumed by the protocol). */
  marketCapSol: number | null;
  marketCapMethod: string;
  realSolReserves: number | null;
  bondingProgressPct: number | null;
  windows: WindowStats[];
  volatility5mPct: number | null;
  momentum1mPct: number | null;
  momentum5mPct: number | null;
  drawdownFromPeakPct: number | null;
  peakPriceSol: number | null;
  volumeAcceleration: number | null;
  liquidityChange5mPct: number | null;
  topTraderVolumeShare: number | null;
  roundTripTraderShare: number | null;
  repeatedSizeShare: number | null;
  tradesPerTrader: number | null;
  creatorSoldTokensPct: number | null;
  creatorNetSol: number | null;
  tradeCount: number;
  lastTradeAt: number | null;
}

export interface HolderEntry {
  tokenAccount: string;
  owner: string | null;
  amountRaw: string;
  pct: number;
  label: 'bonding_curve' | 'amm_pool' | 'creator' | 'holder' | 'unknown';
}

export interface HolderSnapshot {
  fetchedAt: number;
  source: string;
  supplyRaw: string;
  holders: HolderEntry[];
  /** Concentration excluding protocol-controlled accounts. */
  top1Pct: number;
  top10Pct: number;
  creatorPct: number | null;
  protocolPct: number;
}

export interface MintInfo {
  fetchedAt: number;
  source: string;
  tokenProgram: string;
  decimals: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  /** Extensions that can restrict or tax transfers. */
  riskyExtensions: string[];
}

export interface ScenarioResult {
  name: 'bull' | 'base' | 'bear' | 'rug';
  probability: number;
  exitPriceChangePct: number;
  netPnlSol: number;
  netPnlPct: number;
  explanation: string;
}

export interface ProfitabilityEstimate {
  sizeSol: number;
  entryPriceSol: number | null;
  expectedTokensRaw: string;
  entrySlippagePct: number;
  entryImpactPct: number;
  exitImpactPct: number;
  roundTripCostPct: number;
  networkFeesSol: number;
  protocolFeesSol: number;
  scenarios: ScenarioResult[];
  expectedNetSol: number;
  expectedNetPct: number;
  rewardToRisk: number | null;
  probabilityExitBlocked: number;
  executableExitSol: number;
  expectedHoldSec: number;
  assumptions: string[];
}

export interface TokenSummary {
  mint: string;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  createdAt: number | null;
  venue: Venue;
  quoteMint: string | null;
  complete: boolean;
  priceSol: number | null;
  marketCapSol: number | null;
  realSolReserves: number | null;
  bondingProgressPct: number | null;
  volume5mSol: number;
  volume1hSol: number;
  momentum5mPct: number | null;
  riskScore: number | null;
  riskTier: RiskTier | null;
  dataConfidence: number | null;
  criticalFlags: CriticalFlag[];
  expectedNetPct: number | null;
  exitLiquiditySol: number | null;
  action: RecommendedAction;
  actionReason: string;
  strategy: string | null;
  lastUpdate: number;
}

export interface TokenAssessment {
  id?: number;
  mint: string;
  assessedAt: number;
  summary: TokenSummary;
  features: MarketFeatures;
  risk: RiskAssessment;
  opportunity: { score: number; findings: Finding[] };
  profitability: ProfitabilityEstimate | null;
  holders: HolderSnapshot | null;
  mintInfo: MintInfo | null;
  recommendation: { action: RecommendedAction; reasons: string[]; strategy: string | null };
}

export type OrderStatus =
  | 'CREATED'
  | 'VALIDATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'SETTLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'RECONCILING';

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['SETTLED', 'FAILED', 'EXPIRED', 'REJECTED', 'CANCELLED'];

export interface OrderRecord {
  id: number;
  idempotencyKey: string;
  mode: TradingMode;
  mint: string;
  side: Side;
  venue: Venue;
  strategy: string;
  status: OrderStatus;
  requestedSol: number | null;
  requestedTokensRaw: string | null;
  maxSlippagePct: number;
  quotedTokensRaw: string | null;
  quotedSol: number | null;
  filledTokensRaw: string | null;
  filledSol: number | null;
  feeSol: number | null;
  signature: string | null;
  lastValidBlockHeight: number | null;
  attempts: number;
  error: string | null;
  reason: string;
  positionId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PositionRecord {
  id: number;
  mode: TradingMode;
  mint: string;
  symbol: string | null;
  strategy: string;
  status: 'open' | 'closing' | 'closed' | 'stuck';
  venue: Venue;
  tokenAmountRaw: string;
  costBasisSol: number;
  entryPriceSol: number;
  entryAt: number;
  exitAt: number | null;
  realizedPnlSol: number;
  proceedsSol: number;
  feesSol: number;
  peakValueSol: number;
  stopPct: number;
  targetPct: number;
  maxHoldSec: number;
  lastIndicativeValueSol: number | null;
  lastExecutableValueSol: number | null;
  lastValuationAt: number | null;
  closeReason: string | null;
  meta: PositionMeta;
}

export interface PositionMeta {
  partialTaken?: boolean;
  trailingPct?: number;
  thesis?: string;
  exitAttempts?: number;
  lastExitError?: string;
  stuckSince?: number;
}

export interface PortfolioSummary {
  mode: TradingMode;
  configuredCapitalSol: number;
  cashSol: number;
  walletSol: number | null;
  reservedSol: number;
  availableSol: number;
  openExposureSol: number;
  indicativeValueSol: number;
  executableValueSol: number;
  equitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  todayPnlSol: number;
  dayStartEquitySol: number;
  peakEquitySol: number;
  drawdownPct: number;
  feesPaidSol: number;
  openPositions: number;
  tradeCount: number;
  consecutiveLosses: number;
  valuationMethod: string;
}

export interface ProviderHealth {
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  latencyMs: number | null;
  detail: string;
}

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  changedAt: number | null;
  changedBy: string | null;
}

export interface SystemStatus {
  mode: TradingMode;
  liveArmed: boolean;
  liveAllowedByEnv: boolean;
  walletPublicKey: string | null;
  killSwitch: KillSwitchState;
  entriesBlocked: boolean;
  entryBlockReasons: string[];
  providers: ProviderHealth[];
  trackedTokens: number;
  startedAt: number;
  version: string;
  paperTradesClosed: number;
  minPaperTradesForLive: number;
}

export interface Alert {
  id: number;
  level: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  mint: string | null;
  createdAt: number;
}
