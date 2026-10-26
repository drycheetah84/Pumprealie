import type { HolderSnapshot, OrderRecord, TokenAssessment } from '../../shared/types';
import { LineChart, ScoreBar } from '../components/charts';
import { ActionBadge, ErrorBox, Flags, Panel, RiskBadge, Stat } from '../components/ui';
import { ago, cls, dateTime, pct, price, short, sol, solscanToken, solscanTx, time, tokens } from '../format';
import { usePoll } from '../hooks';

interface TokenResp {
  token: { name: string | null; symbol: string | null; creator: string | null; createdAt: number | null; venue: string; tokenProgram: string | null } | null;
  live: {
    venue: string;
    complete: boolean;
    pool: string | null;
    quoteMint: string | null;
    quoteVerified: boolean;
    observedFromLaunch: boolean;
    isMayhem: boolean;
    liquidity: { realQuoteReserve: number; quoteReserve: number; baseReserve: number; feeBps: number; source: string; observedAt: number } | null;
    rpcCheckedAt: number | null;
    inconsistencyPct: number | null;
    sources: string[];
    dex: { dexId: string; liquidityUsd: number | null; volume: { h1: number | null; h24: number | null }; priceUsd: number | null; fetchedAt: number } | null;
    creatorActivity: { txLastHour: number; sampled: number } | null;
    creatorStats: { launches: number; graduated: number; flagged: number } | null;
    creatorFlow: { boughtTokens: number; soldTokens: number; solIn: number; solOut: number };
  } | null;
  assessment: TokenAssessment | null;
  candles: Array<{ minute: number; close: number; volumeSol: number; buys: number; sells: number; realSol: number | null }>;
  liquidityHistory: Array<{ ts: number; realSol: number; priceSol: number | null }>;
  recentTrades: Array<{ ts: number; side: string; sol: number; tokens: number; trader: string; signature: string; isCreator: boolean }>;
  assessments: Array<{ id: number; at: number; riskScore: number; tier: string; action: string; strategy: string | null; expectedNetPct: number | null }>;
  decisions: Array<{ id: number; at: number; mode: string; strategy: string; approved: boolean; sizeSol: number; reasons: string[] }>;
  orders: OrderRecord[];
}

function Holders({ h }: { h: HolderSnapshot | null }) {
  if (!h) return <div className="muted">Holder distribution unavailable — treated as a risk, not as safety.</div>;
  return (
    <>
      <div className="kv" style={{ marginBottom: 8 }}>
        <dt>Source</dt>
        <dd>{h.source}</dd>
        <dt>Top 1 / top 10</dt>
        <dd>
          {h.top1Pct.toFixed(1)}% / {h.top10Pct.toFixed(1)}% <span className="muted">(protocol accounts excluded)</span>
        </dd>
        <dt>Creator</dt>
        <dd>{h.creatorPct === null ? '—' : `${h.creatorPct.toFixed(2)}%`}</dd>
        <dt>Protocol-held</dt>
        <dd>{h.protocolPct.toFixed(1)}%</dd>
        <dt>As of</dt>
        <dd>{ago(h.fetchedAt)} ago</dd>
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>Owner</th>
            <th>Label</th>
            <th className="r">Share</th>
          </tr>
        </thead>
        <tbody>
          {h.holders.slice(0, 12).map((x, i) => (
            <tr key={i}>
              <td className="mono small">{short(x.owner ?? x.tokenAccount, 6)}</td>
              <td>
                <span className={`badge ${x.label === 'bonding_curve' || x.label === 'amm_pool' ? 'info' : x.label === 'creator' ? 'warn' : ''}`}>{x.label.replace('_', ' ')}</span>
              </td>
              <td className="r num">{x.pct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function TokenPage({ mint }: { mint: string }) {
  const { data, error } = usePoll<TokenResp>(mint ? `/api/tokens/${mint}` : null, 5000);
  const a = data?.assessment ?? null;
  const live = data?.live ?? null;
  const name = data?.token?.symbol ?? a?.summary.symbol ?? mint.slice(0, 6);
  const priceSeries = (data?.candles ?? []).map((c) => ({ x: c.minute * 60_000, y: c.close }));
  const liqSeries = (data?.liquidityHistory ?? []).map((p) => ({ x: p.ts, y: p.realSol }));
  const prof = a?.profitability ?? null;

  return (
    <>
      <ErrorBox error={error} />
      <div className="panel panel-b" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>
            {name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{data?.token?.name ?? a?.summary.name ?? ''}</span>
          </div>
          <div className="mono small muted">
            {mint} · <a href={solscanToken(mint)} target="_blank" rel="noreferrer">explorer</a>
          </div>
        </div>
        <div className="spacer" />
        {a && <RiskBadge score={a.risk.score} tier={a.risk.tier} />}
        {a && <ActionBadge action={a.recommendation.action} />}
        {live?.isMayhem && <span className="badge warn">mayhem mode</span>}
        {live && <span className="badge">{live.venue === 'pumpswap' ? 'PumpSwap pool' : live.complete ? 'curve complete (migrating)' : 'bonding curve'}</span>}
      </div>
      {a && (
        <div className={`banner ${a.recommendation.action === 'buy' ? 'warn' : a.risk.criticalFlags.length ? 'danger' : 'info'}`}>
          <div>
            <b>{a.recommendation.action.toUpperCase()}</b>
            {a.recommendation.strategy ? ` · ${a.recommendation.strategy}` : ''} — {a.recommendation.reasons.join(' · ')}
          </div>
        </div>
      )}
      {a && (
        <div className="grid g6">
          <Stat label="Price (SOL)" value={price(a.features.priceSol)} hint={`as of ${time(a.features.asOf)}`} />
          <Stat label="Market cap (SOL)" value={sol(a.features.marketCapSol, 1)} hint={a.features.marketCapMethod} />
          <Stat label="Liquidity" value={`${sol(a.features.realSolReserves, 2)} SOL`} hint={a.features.bondingProgressPct !== null ? `curve ${a.features.bondingProgressPct.toFixed(1)}% complete` : undefined} />
          <Stat label="Momentum 5m" value={pct(a.features.momentum5mPct)} tone={cls(a.features.momentum5mPct)} hint={`1m ${pct(a.features.momentum1mPct)}`} />
          <Stat label="Volatility 5m" value={pct(a.features.volatility5mPct, 1, false)} hint={`drawdown ${pct(a.features.drawdownFromPeakPct)}`} />
          <Stat label="Data confidence" value={`${Math.round(a.risk.dataConfidence * 100)}%`} hint={a.risk.missing.length ? `missing: ${a.risk.missing.join(', ')}` : 'complete'} />
        </div>
      )}
      <div className="grid g2">
        <Panel title="Price" sub="1-minute closes (SOL)">
          <LineChart
            series={[{ label: 'close', color: '#f0b429', points: priceSeries }]}
            bars={{ label: 'volume', points: (data?.candles ?? []).map((c) => ({ x: c.minute * 60_000, y: c.volumeSol, up: c.buys >= c.sells })) }}
            yFormat={(v) => v.toExponential(2)}
            logScale
          />
        </Panel>
        <Panel title="Liquidity history" sub="withdrawable SOL">
          <LineChart series={[{ label: 'SOL', color: '#5aa6e0', area: true, points: liqSeries }]} yFormat={(v) => v.toFixed(2)} />
        </Panel>
      </div>
      {a && (
        <div className="grid g2">
          <Panel title="Risk breakdown" sub={`${a.risk.score} / 100 · weights are configurable engineering defaults`}>
            {a.risk.criticalFlags.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <Flags flags={a.risk.criticalFlags} />
              </div>
            )}
            <div className="list">
              {a.risk.categories.map((c) => (
                <div key={c.category}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span>{c.category.replace(/_/g, ' ')}</span>
                    <span className="num muted">
                      {c.score.toFixed(0)} × {(c.weight * 100).toFixed(0)}%
                    </span>
                  </div>
                  <ScoreBar value={c.score} />
                  <div className="list" style={{ marginTop: 6 }}>
                    {c.findings.map((f, i) => (
                      <div key={i} className="finding small">
                        <span className={`badge ${f.severity === 'critical' || f.severity === 'high' ? 'down' : f.severity === 'medium' ? 'warn' : ''}`}>{f.severity}</span>
                        <span>{f.message}</span>
                        <span className="meta">
                          +{f.points} · {f.source} · conf {Math.round(f.confidence * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <div className="grid" style={{ alignContent: 'start' }}>
            <Panel title="Profitability" sub={prof ? `reference size ${prof.sizeSol} SOL` : undefined}>
              {!prof && <div className="muted">No executable quote.</div>}
              {prof && (
                <>
                  <div className="kv">
                    <dt>Expected net</dt>
                    <dd className={cls(prof.expectedNetPct)}>
                      {pct(prof.expectedNetPct, 2)} ({sol(prof.expectedNetSol, 5)} SOL)
                    </dd>
                    <dt>Reward / risk</dt>
                    <dd>{prof.rewardToRisk?.toFixed(2) ?? '—'}</dd>
                    <dt>Entry impact · drift</dt>
                    <dd>
                      {pct(prof.entryImpactPct, 2, false)} · {pct(prof.entrySlippagePct, 2, false)}
                    </dd>
                    <dt>Exit impact</dt>
                    <dd>{pct(prof.exitImpactPct, 2, false)}</dd>
                    <dt>Round-trip cost</dt>
                    <dd>{pct(prof.roundTripCostPct, 2, false)}</dd>
                    <dt>Fees (protocol · network)</dt>
                    <dd>
                      {sol(prof.protocolFeesSol, 6)} · {sol(prof.networkFeesSol, 6)} SOL
                    </dd>
                    <dt>Executable exit now</dt>
                    <dd>{sol(prof.executableExitSol, 5)} SOL</dd>
                    <dt>P(exit blocked)</dt>
                    <dd>{(prof.probabilityExitBlocked * 100).toFixed(1)}% (heuristic)</dd>
                  </div>
                  <table className="t" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Scenario</th>
                        <th className="r">Prob.</th>
                        <th className="r">Move</th>
                        <th className="r">Net</th>
                        <th>Assumption</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prof.scenarios.map((s) => (
                        <tr key={s.name}>
                          <td>{s.name}</td>
                          <td className="r num">{(s.probability * 100).toFixed(1)}%</td>
                          <td className="r num">{pct(s.exitPriceChangePct, 0)}</td>
                          <td className={`r num ${cls(s.netPnlPct)}`}>{pct(s.netPnlPct)}</td>
                          <td className="small muted" style={{ whiteSpace: 'normal' }}>
                            {s.explanation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="muted small" style={{ marginTop: 8 }}>
                    {prof.assumptions.join(' · ')}
                  </div>
                </>
              )}
            </Panel>
            <Panel title="Holder concentration">
              <Holders h={a.holders} />
            </Panel>
          </div>
        </div>
      )}
      <div className="grid g2">
        <Panel title="Creator & data sources">
          <div className="kv">
            <dt>Creator</dt>
            <dd>{data?.token?.creator ?? a?.summary.creator ?? '—'}</dd>
            <dt>Observed launches</dt>
            <dd>{live?.creatorStats ? `${live.creatorStats.launches} (graduated ${live.creatorStats.graduated}, flagged ${live.creatorStats.flagged})` : '—'}</dd>
            <dt>Creator trades here</dt>
            <dd>{live ? `bought ${tokens(live.creatorFlow.boughtTokens)} for ${sol(live.creatorFlow.solIn, 3)} SOL · sold ${tokens(live.creatorFlow.soldTokens)} for ${sol(live.creatorFlow.solOut, 3)} SOL` : '—'}</dd>
            <dt>Creator tx (1h)</dt>
            <dd>{live?.creatorActivity ? `${live.creatorActivity.txLastHour} of ${live.creatorActivity.sampled} sampled` : 'not fetched'}</dd>
            <dt>Launched</dt>
            <dd>{dateTime(data?.token?.createdAt ?? null)}</dd>
            <dt>Observed from launch</dt>
            <dd>{live?.observedFromLaunch ? 'yes' : 'no'}</dd>
            <dt>Token program</dt>
            <dd>{a?.mintInfo?.tokenProgram ?? '—'}</dd>
            <dt>Mint / freeze authority</dt>
            <dd>{a?.mintInfo ? `${a.mintInfo.mintAuthority ?? 'none'} / ${a.mintInfo.freezeAuthority ?? 'none'}` : 'unverified'}</dd>
            <dt>Extensions</dt>
            <dd>{a?.mintInfo?.extensions.join(', ') || 'none'}</dd>
            <dt>Quote asset</dt>
            <dd>
              {live?.quoteMint ?? '—'} {live?.quoteVerified ? '(on-chain)' : '(unverified)'}
            </dd>
            <dt>Last on-chain check</dt>
            <dd>{live?.rpcCheckedAt ? `${ago(live.rpcCheckedAt)} ago` : 'never'}</dd>
            <dt>Event/chain mismatch</dt>
            <dd>{live?.inconsistencyPct === null || live?.inconsistencyPct === undefined ? 'n/a' : `${live.inconsistencyPct.toFixed(3)}%`}</dd>
            <dt>Fee</dt>
            <dd>{live?.liquidity ? `${live.liquidity.feeBps} bps` : '—'}</dd>
            <dt>Sources</dt>
            <dd>{live?.sources.join(', ') ?? '—'}</dd>
            {live?.dex && (
              <>
                <dt>DexScreener</dt>
                <dd>
                  {live.dex.dexId} · liq ${live.dex.liquidityUsd?.toFixed(0) ?? '—'} · vol 1h ${live.dex.volume.h1?.toFixed(0) ?? '—'} ({ago(live.dex.fetchedAt)} ago)
                </dd>
              </>
            )}
          </div>
        </Panel>
        <Panel title="Recent transactions" pad={false}>
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th className="r">SOL</th>
                  <th className="r">Tokens</th>
                  <th>Trader</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recentTrades ?? []).map((t, i) => (
                  <tr key={i}>
                    <td className="muted small">{time(t.ts)}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side}</td>
                    <td className="r num">{t.sol.toFixed(4)}</td>
                    <td className="r num">{tokens(t.tokens)}</td>
                    <td className="mono small">
                      {short(t.trader)} {t.isCreator && <span className="badge warn">creator</span>}
                    </td>
                    <td className="small">
                      <a href={solscanTx(t.signature)} target="_blank" rel="noreferrer">
                        {short(t.signature, 4)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      <div className="grid g2">
        <Panel title="Assessment history" pad={false}>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Risk</th>
                  <th>Action</th>
                  <th>Strategy</th>
                  <th className="r">Exp. net</th>
                </tr>
              </thead>
              <tbody>
                {(data?.assessments ?? []).map((x) => (
                  <tr key={x.id}>
                    <td className="muted small">{time(x.at)}</td>
                    <td className="num">
                      {x.riskScore?.toFixed(0)} <span className="muted">{x.tier}</span>
                    </td>
                    <td>
                      <ActionBadge action={x.action} />
                    </td>
                    <td>{x.strategy ?? '—'}</td>
                    <td className={`r num ${cls(x.expectedNetPct)}`}>{pct(x.expectedNetPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Decisions & orders" pad={false}>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="t">
              <tbody>
                {(data?.decisions ?? []).map((d) => (
                  <tr key={`d${d.id}`}>
                    <td className="muted small">{time(d.at)}</td>
                    <td>
                      <span className={`badge ${d.approved ? 'accent' : ''}`}>{d.approved ? `approved ${d.sizeSol} SOL` : 'rejected'}</span>
                    </td>
                    <td className="small" style={{ whiteSpace: 'normal' }}>
                      {d.strategy} · {d.reasons.join('; ') || 'all gates passed'}
                    </td>
                  </tr>
                ))}
                {(data?.orders ?? []).map((o) => (
                  <tr key={`o${o.id}`}>
                    <td className="muted small">{time(o.createdAt)}</td>
                    <td>
                      <span className={`badge ${o.status === 'SETTLED' ? 'up' : ['FAILED', 'EXPIRED', 'REJECTED'].includes(o.status) ? 'down' : 'info'}`}>
                        {o.mode} {o.side} {o.status}
                      </span>
                    </td>
                    <td className="small">{o.error ?? o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data?.decisions.length && !data?.orders.length && <div className="empty">No decisions yet</div>}
          </div>
        </Panel>
      </div>
    </>
  );
}
