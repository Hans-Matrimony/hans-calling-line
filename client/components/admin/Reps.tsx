'use client';
import { useEffect, useMemo } from 'react';
import { relative, since } from '../../lib/format';
import { qs, useAdmin, pct, fpct, type Filters, type Rep, type RepDetail } from '../../lib/admin';
import { KpiRow } from './Overview';
import Columns, { DIALS_CONNECTS, scale, type Band } from './Columns';
import { CallTable } from './Calls';

const STATUS_LABEL: Record<string, string> = { queued: 'queued', later: 'callback booked', in_flight: 'on a call now', connected: 'connected · done', exhausted: 'exhausted · out of tries', stopped: 'stopped' };

export default function Reps({ filters, tick, reps, focus, onFocus, onLead }: {
  filters: Filters; tick: number; reps: Rep[]; focus: number | null; onFocus: (id: number) => void; onLead: (id: number) => void;
}) {
  useEffect(() => { if (!focus && reps.length) onFocus(reps[0].id); }, [reps, focus, onFocus]);
  const id = focus ?? reps[0]?.id ?? null;
  const d = useAdmin<RepDetail>(id ? `/api/admin/reps/${id}?` + qs({ ...filters, rep: null }) : null, tick);
  const r = d.data;

  const hourBands: Band[] = useMemo(() => (r?.byHour ?? []).map((h) => ({
    key: String(h.hour), label: String(h.hour).padStart(2, '0'), tip: `${String(h.hour).padStart(2, '0')}:00–${String(h.hour + 1).padStart(2, '0')}:00 IST`,
    values: { dials: h.dials, connects: h.connects },
  })), [r?.byHour]);
  const hs = scale(Math.max(1, ...hourBands.map((b) => b.values.dials)));
  const queue = (st: string) => (r?.queue ?? []).filter((x) => x.status === st).reduce((a, x) => a + x.n, 0);
  const bySource = (src: string) => (r?.queue ?? []).filter((x) => x.source === src).reduce((a, x) => a + x.n, 0);
  const totalLeads = (r?.queue ?? []).reduce((a, x) => a + x.n, 0);
  const nextOpen = r?.readiness.next_open_at ? new Date(r.readiness.next_open_at) : null;

  return (
    <section className="ad-screen">
      <div className="ad-chips">
        {reps.map((x) => <button key={x.id} className={'ad-chip' + (x.id === id ? ' on' : '')} onClick={() => onFocus(x.id)}>{x.email.split('@')[0]}</button>)}
        {reps.length === 0 && <span className="hint">No active reps yet — add one on the Users screen.</span>}
      </div>
      {d.error && <p className="ad-err">{d.error}</p>}
      {r && (
        <>
          <KpiRow s={{ ...filters, rep: id, current: r.current, previous: r.previous }} filters={filters} />

          <div className="ad-two">
            <div className="panel">
              <div className="panel-head">
                <h2 className="panel-title">By hour of day<b>IST</b></h2>
                <div className="ad-legend">{DIALS_CONNECTS.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}<span><i style={{ background: 'var(--panel-2)', border: '1px solid var(--line-2)' }} />Shift 14:00–23:00</span></div>
              </div>
              <Columns bands={hourBands} series={DIALS_CONNECTS} yMax={hs.yMax} ticks={hs.ticks} height={220} bw={9} labelEvery={3} shift={[14, 23]} />
              <p className="hint" style={{ margin: '8px 0 0' }}>When this rep dials, and when the connects land, over the selected period.</p>
            </div>
            <div className="panel">
              <div className="panel-head"><h2 className="panel-title">By country</h2></div>
              <div className="ad-scroll"><table className="ad-tbl">
                <thead><tr><th>Country</th><th className="num">Dials</th><th className="num">Connects</th><th>Rate</th></tr></thead>
                <tbody>
                  {r.byCountry.map((c) => (
                    <tr key={c.country || '(none)'}><td className={c.country ? '' : 'dim'}>{c.country || 'no country on the lead'}</td><td className="num">{c.dials}</td><td className="num">{c.connects}</td>
                      <td><span className="ad-ratebar"><i style={{ ['--w' as string]: `${Math.min(100, pct(c.connects, c.dials) * 2.5).toFixed(0)}%` }} /><span className="mono">{c.dials ? fpct(pct(c.connects, c.dials)) : '—'}</span></span></td></tr>
                  ))}
                  {r.byCountry.length === 0 && <tr><td colSpan={4} className="dim">No dials in this period.</td></tr>}
                </tbody>
              </table></div>
            </div>
          </div>

          <div className="ad-two">
            <div className="panel">
              <div className="panel-head"><h2 className="panel-title">Queue<b>{totalLeads} leads</b></h2><span className="hint">why a lead is or is not dialable right now</span></div>
              <div className="ad-qs">
                <div className="ad-q"><b>{queue('queued')}</b><span>queued</span></div>
                <div className="ad-q"><b>{r.readiness.ready}</b><span>due right now</span></div>
                <div className="ad-q"><b>{r.readiness.waiting_gap}</b><span>waiting on the 2 h gap</span></div>
                <div className="ad-q"><b>{r.readiness.waiting_window}</b><span>waiting on their clock</span></div>
                <div className="ad-q"><b>{queue('later')}</b><span>{STATUS_LABEL.later}</span></div>
                <div className="ad-q"><b>{queue('connected')}</b><span>{STATUS_LABEL.connected}</span></div>
                <div className="ad-q"><b>{queue('exhausted')}</b><span>{STATUS_LABEL.exhausted}</span></div>
                <div className="ad-q"><b>{queue('stopped')}</b><span>{STATUS_LABEL.stopped}</span></div>
                <div className="ad-q"><b>{bySource('csv')}</b><span>from CSV</span></div>
                <div className="ad-q"><b>{bySource('hubspot')}</b><span>from HubSpot</span></div>
                <div className="ad-q"><b>{bySource('manual')}</b><span>typed on the keypad</span></div>
              </div>
              {r.readiness.ready === 0 && nextOpen && <p className="hint" style={{ margin: '12px 0 0' }}>Nobody is due right now. Next opens {relative(nextOpen)}.</p>}
            </div>
            <div className="panel">
              <div className="panel-head"><h2 className="panel-title">HubSpot</h2></div>
              {!r.hubspot.configured ? <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><span className="lamp grey" /><span>Not connected — <span className="mono">HUBSPOT_TOKEN</span> is not set on the server.</span></p>
                : r.hubspot.ok === false ? <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><span className="lamp coral" /><span>{r.hubspot.error}</span></p>
                : <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><span className="lamp green" /><span>{r.hubspot.syncedAt ? `Synced ${since(new Date(r.hubspot.syncedAt))}` : 'First sync on the way'}{r.hubspot.inQueue ? ` · ${r.hubspot.inQueue} ticked contact${r.hubspot.inQueue === 1 ? '' : 's'} in the queue` : ''}</span></p>}
              <p className="hint" style={{ margin: '10px 0 0' }}>This rep is {reps.find((x) => x.id === id)?.hubspot_mapped ? 'matched to a HubSpot user by email' : 'not matched to any HubSpot user — their dialer email must be their HubSpot email'}.</p>
              <div className="panel-head" style={{ marginTop: 18 }}><h2 className="panel-title">Now</h2></div>
              <p style={{ margin: 0 }} className="hint">{r.now ? ({ on_call: 'On a call', ringing: 'Ringing a lead', idle: 'Audio on, between calls', off: 'Audio off' }[r.now.state]) : '—'}</p>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h2 className="panel-title">Recent calls<b>last 20</b></h2><span className="hint">the Calls screen has every one, with export</span></div>
            <CallTable rows={r.recent} onLead={onLead} showRep={false} />
          </div>
        </>
      )}
    </section>
  );
}
