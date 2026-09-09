'use client';
import { useMemo } from 'react';
import { prettyPhone, talkTime as talk } from '../../lib/format';
import { qs, useAdmin, pct, fpct, secs, OUTCOME_LABEL, OUTCOME_LAMP, type Filters, type Summary, type Day, type Outcome, type Rep, type CallerId, type Live } from '../../lib/admin';
import { Kpi, deltaOf } from './Kpi';
import Columns, { DIALS_CONNECTS, scale, type Band } from './Columns';

const VS: Record<string, string> = { today: 'yesterday', yesterday: 'the day before', '7d': 'previous 7 days', '30d': 'previous 30 days', custom: 'previous period' };
const LIVE_LABEL: Record<Live['state'], string> = { on_call: 'on a call', ringing: 'ringing', idle: 'audio on · between calls', off: 'off' };
const LIVE_LAMP: Record<Live['state'], string> = { on_call: 'green', ringing: 'amber', idle: 'green', off: 'grey' };

/** Summary KPI row + the connect-rate hero, shared by Overview and the Reps screen. */
export function KpiRow({ s, filters }: { s: Summary; filters: Filters }) {
  const c = s.current, p = s.previous, vs = VS[filters.period] ?? 'previous period';
  const seg = filters.segment;
  const [hc, hd] = seg === 'india' ? [c.in_connects, c.in_dials] : [c.ni_connects, c.ni_dials];
  const [pc, pd] = seg === 'india' ? [p.in_connects, p.in_dials] : [p.ni_connects, p.ni_dials];
  const rate = pct(hc, hd), prevRate = pd ? pct(pc, pd) : null;
  const heroLabel = seg === 'india' ? 'Connect rate · India' : 'Connect rate · non-India';
  const sub = seg === 'all'
    ? <><span>{hc} of {hd} dials</span><span>India <b>{fpct(pct(c.in_connects, c.in_dials))}</b> · {c.in_connects} of {c.in_dials}</span></>
    : <span>{hc} of {hd} dials</span>;
  const dials = seg === 'non_india' ? c.ni_dials : seg === 'india' ? c.in_dials : c.dials;
  const connects = seg === 'non_india' ? c.ni_connects : seg === 'india' ? c.in_connects : c.connects;
  const pDials = seg === 'non_india' ? p.ni_dials : seg === 'india' ? p.in_dials : p.dials;
  const pConnects = seg === 'non_india' ? p.ni_connects : seg === 'india' ? p.in_connects : p.connects;
  const had = (n: number) => (p.dials > 0 ? n : null); // no earlier period at all → say so instead of "+n"
  return (
    <div className="ad-kpis">
      <Kpi hero label={heroLabel} value={rate.toFixed(1)} unit="%" delta={deltaOf(rate, prevRate, { vs, unit: 'pts' })} sub={sub} />
      <Kpi label="Dials" value={dials} delta={deltaOf(dials, had(pDials), { vs })} />
      <Kpi label="Connects" value={connects} delta={deltaOf(connects, had(pConnects), { vs })} />
      <Kpi label="Talk time" value={talk(c.talk_secs)} delta={deltaOf(c.talk_secs, had(p.talk_secs), { vs, unit: 's' })} />
      <Kpi label="Attempts / lead" value={c.leads_dialed ? (c.dials / c.leads_dialed).toFixed(2) : '—'} delta={deltaOf(c.leads_dialed ? c.dials / c.leads_dialed : 0, p.leads_dialed ? p.dials / p.leads_dialed : null, { vs, unit: 'x', neutral: true })} />
      <Kpi label="Reach" value={pct(c.leads_reached, c.leads_dialed).toFixed(0)} unit="%" delta={deltaOf(pct(c.leads_reached, c.leads_dialed), p.leads_dialed ? pct(p.leads_reached, p.leads_dialed) : null, { vs, unit: 'pts' })} />
      <Kpi label="Abandoned" value={pct(c.abandoned, c.dials).toFixed(1)} unit="%" note={`${c.abandoned} calls · target < 2%`} />
      <Kpi label="Wrap-up" value={c.wrap_median == null ? '—' : c.wrap_median.toFixed(0)} unit={c.wrap_median == null ? '' : 's'} note="median after a call" />
    </div>
  );
}

export default function Overview({ filters, tick, onRep }: { filters: Filters; tick: number; onRep: (id: number) => void }) {
  const q = qs(filters);
  const summary = useAdmin<Summary>('/api/admin/summary?' + q, tick);
  const days = useAdmin<Day[]>('/api/admin/by-day?' + qs(filters, { days: filters.period === '30d' ? 30 : 14 }), tick);
  const outcomes = useAdmin<Outcome[]>('/api/admin/outcomes?' + q, tick);
  const reps = useAdmin<Rep[]>('/api/admin/reps?' + q, tick);
  const cids = useAdmin<CallerId[]>('/api/admin/caller-ids', tick);
  const live = useAdmin<Live[]>('/api/admin/live', tick);

  const bands: Band[] = useMemo(() => (days.data ?? []).map((d) => {
    const inPeriod = summary.data ? d.day >= summary.data.from && d.day <= summary.data.to : true;
    const label = d.day.slice(8) + ' ' + new Date(d.day + 'T00:00:00Z').toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    return { key: d.day, label, tip: label + ' · IST', values: { dials: d.dials, connects: d.connects }, dim: !inPeriod, emphasis: inPeriod && d.day === summary.data?.to };
  }), [days.data, summary.data]);
  const sc = scale(Math.max(1, ...bands.map((b) => b.values.dials)));
  const oc = (outcomes.data ?? []).filter((o) => o.outcome !== 'cancelled');
  const cancelled = (outcomes.data ?? []).find((o) => o.outcome === 'cancelled')?.n ?? 0;
  const ocMax = Math.max(1, ...oc.map((o) => o.n));

  return (
    <section className="ad-screen">
      {summary.error && <p className="ad-err">{summary.error}</p>}
      {summary.data && <KpiRow s={summary.data} filters={filters} />}

      <div className="ad-two">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Dials &amp; connects by day</h2>
            <div className="ad-legend">{DIALS_CONNECTS.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
          </div>
          {bands.length ? <Columns bands={bands} series={DIALS_CONNECTS} yMax={sc.yMax} ticks={sc.ticks} bw={bands.length > 20 ? 8 : 22} labelEvery={bands.length > 20 ? 5 : 1} /> : <p className="empty">Loading…</p>}
          <p className="hint" style={{ margin: '8px 0 0' }}>Days outside the selected period are dimmed. Hover a day for its numbers.</p>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Outcomes<b>{summary.data?.current.dials ?? '…'} dials</b></h2><span className="hint">every dial ends in one of these</span></div>
          {oc.length === 0 ? <p className="empty">No dials in this period.</p> : (
            <div className="ad-bars">
              {oc.map((o) => (
                <div className={'ad-bar' + (o.outcome === 'connected_unspecified' ? ' warn' : '')} key={o.outcome} title={`${OUTCOME_LABEL[o.outcome] ?? o.outcome}: ${o.n}`}>
                  <span className="n"><span className={'lamp ' + (OUTCOME_LAMP[o.outcome] ?? 'grey')} />{OUTCOME_LABEL[o.outcome] ?? o.outcome}</span>
                  <div><div className="t" style={{ width: `${(100 * o.n / ocMax).toFixed(1)}%` }} /></div>
                  <span className="c">{o.n}</span>
                </div>
              ))}
            </div>
          )}
          {cancelled > 0 && <p className="hint" style={{ margin: '10px 0 0' }}>+{cancelled} cancelled legs — the loser of a burst, not a dial</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2 className="panel-title">Reps</h2><span className="hint">click a rep to open them · sorted by dials</span></div>
        <div className="ad-scroll"><table className="ad-tbl">
          <thead><tr><th>Rep</th><th className="num">Dials</th><th className="num">Connects</th><th>Rate</th><th className="num">Talk</th><th className="num">Wrap-up</th><th className="num">In queue</th><th>HubSpot</th><th>Now</th></tr></thead>
          <tbody>
            {(reps.data ?? []).map((r) => (
              <tr className="row" key={r.id} onClick={() => onRep(r.id)}>
                <td className="name">{r.email.split('@')[0]}<span className="sub">{r.email}</span></td>
                <td className="num">{r.dials}</td><td className="num">{r.connects}</td>
                <td><span className="ad-ratebar"><i style={{ ['--w' as string]: `${Math.min(100, pct(r.connects, r.dials) * 2.5).toFixed(0)}%` }} /><span className="mono">{r.dials ? fpct(pct(r.connects, r.dials)) : '—'}</span></span></td>
                <td className="num">{r.talk_secs ? talk(r.talk_secs) : '—'}</td>
                <td className="num">{r.wrap_median == null ? <span className="dim">—</span> : r.wrap_median.toFixed(1) + 's'}</td>
                <td className="num">{r.in_queue}</td>
                <td><span className={'ad-pill ' + (r.hubspot === 'mapped' ? 'green' : 'grey')}>{r.hubspot}</span></td>
                <td>{r.now ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><span className={'lamp ' + LIVE_LAMP[r.now.state]} style={{ animation: 'none' }} />{LIVE_LABEL[r.now.state]}</span> : '—'}</td>
              </tr>
            ))}
            {reps.data && reps.data.length === 0 && <tr><td colSpan={9} className="dim">No active reps.</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="ad-two">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Caller IDs<b>today</b></h2><span className="hint">{cids.data?.[0]?.cap ?? 100} dials per number per day, then it stops · resets 05:30 IST</span></div>
          <div className="ad-cid">
            {(cids.data ?? []).map((n) => {
              const hot = n.usedToday / n.cap > 0.8;
              return (
                <div className="row" key={n.number}>
                  <span className="n">{prettyPhone(n.number)}<small>{n.region === 'us' ? 'United States' : n.region === 'eu' ? 'UK / Europe' : 'India'} · {n.ever} dials ever</small></span>
                  <div className={'track' + (hot ? ' hot' : '')}><i style={{ width: `${Math.min(100, 100 * n.usedToday / n.cap)}%` }} /></div>
                  <span className={'v' + (hot ? ' hot' : '')}>{n.usedToday} <span className="muted">/ {n.cap}</span></span>
                </div>
              );
            })}
            {cids.data && cids.data.length === 0 && <p className="empty">No caller IDs configured on the server.</p>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Live</h2><span className="hint">updates as it happens</span></div>
          <div className="ad-live">
            {(live.data ?? []).map((l) => (
              <span className={'rep ' + l.state} key={l.id}>
                <span className={'lamp ' + LIVE_LAMP[l.state]} style={l.state === 'ringing' ? undefined : { animation: 'none' }} />
                <b>{l.email.split('@')[0]}</b>
                {l.with ? <span className="mono">{LIVE_LABEL[l.state]} · {l.with.name || prettyPhone(l.with.phone)}{l.with.since ? ' · ' + secs((Date.now() - new Date(l.with.since).getTime()) / 1000) : ''}</span> : <span className="muted">{LIVE_LABEL[l.state]}</span>}
              </span>
            ))}
            {live.data && live.data.length === 0 && <p className="empty">No active reps.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
