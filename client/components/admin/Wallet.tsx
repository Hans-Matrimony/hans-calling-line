'use client';
import { useMemo, useState } from 'react';
import { patch } from '../../lib/api';
import { since } from '../../lib/format';
import { useAdmin, money, type Wallet as WalletT, type WalletPeriod, type Health, type Settings } from '../../lib/admin';
import Columns, { scale, type Band } from './Columns';
import { Refresh } from '../icons';

function Card({ title, p }: { title: string; p: WalletPeriod }) {
  const ccy = p.currency ?? 'USD';
  const per = (n: number) => (n ? money(p.spend / n, ccy) : '—');
  return (
    <div className="card">
      <div className="h">{title}</div>
      <div className="big">{money(p.spend, ccy)}</div>
      <div className="kv">
        <span>per dial (all-in)</span><b>{per(p.dials)}</b>
        <span>per dial, lead legs only</span><b>{p.dials ? money(p.lead_spend / p.dials, ccy) : '—'}</b>
        <span>per connect</span><b>{per(p.connects)}</b>
        <span>per billed minute</span><b>{p.billed_secs ? money(p.spend / (p.billed_secs / 60), ccy) : '—'}</b>
        <span>rep audio sessions</span><b>{money(p.rep_spend, ccy)}</b>
        <span>legs billed</span><b>{p.legs}</b>
        <span>dials · connects</span><b>{p.dials} · {p.connects}</b>
        {p.awaiting_cost > 0 && <><span>not yet billed by Plivo</span><b>{p.awaiting_cost} leg{p.awaiting_cost === 1 ? '' : 's'}</b></>}
      </div>
    </div>
  );
}

export default function Wallet({ tick }: { tick: number }) {
  const [bump, setBump] = useState(0);
  const w = useAdmin<WalletT>('/api/admin/wallet', tick + bump);
  const h = useAdmin<Health>('/api/admin/health', tick + bump);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const s = settings ?? h.data?.settings ?? null;
  const toggle = async (v: boolean) => {
    setSaving(true);
    try { setSettings(await patch<Settings>('/api/admin/settings', { hubspot_create_contacts: v })); } finally { setSaving(false); }
  };
  const bands: Band[] = useMemo(() => (w.data?.byDay ?? []).map((d) => ({ key: d.day, label: d.day.slice(8), tip: d.day, values: { spend: d.spend } })), [w.data]);
  const sc = scale(Math.max(0.01, ...bands.map((b) => b.values.spend)));
  const bal = w.data?.balance;
  const parts = w.data?.periods.d30.parts ?? [];
  const pmax = Math.max(0.0001, ...parts.map((p) => p.cost));
  const hs = h.data?.hubspot;

  return (
    <section className="ad-screen ad-wallet">
      <div className="ad-two">
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Plivo balance</h2><button className="btn btn-mini" onClick={() => setBump((b) => b + 1)}><Refresh />Refresh</button></div>
          {!bal ? <p className="empty">Loading…</p> : 'error' in bal ? <p className="ad-err">{bal.error}</p> : (
            <>
              <div className="big">{money(bal.availableCredit, bal.currency)}</div>
              <div className="kv" style={{ marginTop: 8 }}>
                <span>balance</span><b>{money(bal.balance, bal.currency)}</b>
                <span>pending</span><b>{money(bal.pending, bal.currency)}</b>
                {bal.creditLimit ? <><span>credit limit</span><b>{money(bal.creditLimit, bal.currency)}</b></> : null}
                <span>as of</span><b>{since(new Date(bal.asOf))}</b>
              </div>
            </>
          )}
        </div>
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Where the money goes<b>30 days</b></h2></div>
          {parts.length === 0 ? <p className="empty">No billed calls yet. Call charges are fetched from Plivo after hangup; recently ended calls may take a few minutes to appear.</p> : (
            <div className="ad-bars">
              {parts.map((p) => (
                <div className="ad-bar" key={p.part}><span className="n">{p.part}</span><div><div className="t" style={{ width: `${(100 * p.cost / pmax).toFixed(1)}%` }} /></div><span className="c">{money(p.cost)}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>

      {w.data && (
        <div className="cards">
          <Card title="Today" p={w.data.periods.today} />
          <Card title="Last 7 days" p={w.data.periods.d7} />
          <Card title="Last 30 days" p={w.data.periods.d30} />
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h2 className="panel-title">Spend by day<b>30 days · IST</b></h2><div className="ad-legend"><span><i style={{ background: 'var(--blue)' }} />Plivo spend</span></div></div>
        {bands.length ? <Columns bands={bands} series={[{ key: 'spend', label: 'Spend', color: 'var(--blue)' }]} yMax={sc.yMax} ticks={sc.ticks} height={200} bw={12} labelEvery={5} fmt={(v) => money(v)} /> : <p className="empty">Nothing billed yet.</p>}
        <p className="hint" style={{ margin: '8px 0 0' }}>Every leg counts: the lead legs of a burst including the one that lost, dial failures, and every rep audio session. Per-dial cost is all-in so it is honest.</p>
      </div>

      <div className="panel">
        <div className="panel-head"><h2 className="panel-title">Plumbing</h2><span className="hint">what the dashboard depends on</span></div>
        <div className="ad-health">
          {h.data && (
            <>
              <div className="h"><span className={'lamp ' + (h.data.recording.on ? 'green' : 'grey')} /><span>Recording {h.data.recording.on ? 'on' : 'off'}{h.data.recording.beep ? ', with a beep' : ', silent'} · {h.data.recording.saved} saved{h.data.recording.errors ? ` · ${h.data.recording.errors} failed` : ''}</span></div>
              <div className="h"><span className={'lamp ' + (h.data.cost.rows ? 'green' : 'amber')} /><span>Plivo cost events: {h.data.cost.rows ? `${h.data.cost.rows} received, last ${since(new Date(h.data.cost.lastAt!))}` : 'none yet'}</span></div>
              <div className="h"><span className={'lamp ' + (!hs?.configured ? 'grey' : hs.ok === false ? 'coral' : 'green')} /><span>HubSpot inlet: {!hs?.configured ? 'not connected — HUBSPOT_TOKEN is not set' : hs.ok === false ? hs.error : 'working'}</span></div>
              <div className="h"><span className={'lamp ' + (!hs?.configured ? 'grey' : hs.write?.ok === false ? 'coral' : hs.write?.ok ? 'green' : 'grey')} /><span>HubSpot call logging: {!hs?.configured ? 'off' : hs.write?.ok === false ? hs.write.error : `${hs.logged} logged${hs.failed ? ` · ${hs.failed} not logged` : ''}`}</span></div>
            </>
          )}
          <label className="ad-switch" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={!!s?.hubspot_create_contacts} disabled={!s || saving} onChange={(e) => toggle(e.target.checked)} /><i />
            <span>Create a HubSpot contact when a dialed number is not in HubSpot<span className="muted"> — off: those calls stay in this dashboard only</span></span>
          </label>
        </div>
      </div>
    </section>
  );
}
