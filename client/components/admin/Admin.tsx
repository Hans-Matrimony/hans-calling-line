'use client';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API } from '../../lib/api';
import type { Me } from '../../lib/useDialer';
import { DEFAULT_FILTERS, PERIODS, istClock, istToday, qs, useAdmin, type Filters, type Rep, type Segment } from '../../lib/admin';
import { Grid, Users as UsersIcon, Phone, List, Wallet as WalletIcon, LogOut } from '../icons';
import Overview from './Overview';
import Reps from './Reps';
import Calls from './Calls';
import Leads from './Leads';
import Wallet from './Wallet';
import UsersScreen from './Users';
import LeadDrawer from './LeadDrawer';

type Tab = 'overview' | 'reps' | 'calls' | 'leads' | 'wallet' | 'users';
const TABS: { id: Tab; label: string; icon: typeof Grid }[] = [
  { id: 'overview', label: 'Overview', icon: Grid }, { id: 'reps', label: 'Reps', icon: UsersIcon }, { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'leads', label: 'Leads', icon: List }, { id: 'wallet', label: 'Wallet', icon: WalletIcon }, { id: 'users', label: 'Users', icon: UsersIcon },
];
const TITLES: Record<Tab, string> = { overview: 'Overview', reps: 'Reps', calls: 'Calls', leads: 'Leads', wallet: 'Wallet', users: 'Users' };

/** Per-viewer preference, never critical: which tab and which filters were open. */
function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { try { const s = localStorage.getItem(key); if (s) setV({ ...initial, ...JSON.parse(s) }); } catch { /* private mode etc. */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (n: T | ((p: T) => T)) => setV((p) => { const next = typeof n === 'function' ? (n as (p: T) => T)(p) : n; try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ } return next; });
  return [v, set];
}

/** The manager's console: the dialer's shell, one filter row, six screens. Admins never dial. */
export default function Admin({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [ui, setUi] = usePersisted<{ tab: Tab; filters: Filters }>('hans.admin', { tab: 'overview', filters: DEFAULT_FILTERS });
  const { tab, filters } = ui;
  const setTab = (t: Tab) => setUi((p) => ({ ...p, tab: t }));
  const setFilters = (f: Partial<Filters>) => setUi((p) => ({ ...p, filters: { ...p.filters, ...f } }));
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState('');
  const [openLead, setOpenLead] = useState<number | null>(null);
  const [repFocus, setRepFocus] = useState<number | null>(null); // the rep the Reps screen shows

  // Live updates: the server sends one 'admin:poke' per burst of webhooks; we refetch once, debounced.
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const socket = io(API || undefined, { withCredentials: true });
    socket.on('admin:poke', () => { if (pokeTimer.current) clearTimeout(pokeTimer.current); pokeTimer.current = setTimeout(() => setTick((t) => t + 1), 500); });
    const clockT = setInterval(() => setClock(istClock()), 15000);
    setClock(istClock());
    const idle = setInterval(() => setTick((t) => t + 1), 60000); // clocks move even when nobody dials
    return () => { socket.disconnect(); clearInterval(clockT); clearInterval(idle); };
  }, []);

  const reps = useAdmin<Rep[]>('/api/admin/reps?' + qs({ ...filters, period: '30d', rep: null }), tick);
  const showFilters = tab === 'overview' || tab === 'reps' || tab === 'calls' || tab === 'leads';
  const period = filters.period;
  const note = period === 'today' ? 'Today · IST day · vs yesterday' : period === 'yesterday' ? 'Yesterday · IST day · vs the day before'
    : period === '7d' ? 'Last 7 days · vs the 7 before' : period === '30d' ? 'Last 30 days · vs the 30 before' : `${filters.from} → ${filters.to} · IST · vs the same length before`;

  const openRep = (id: number) => { setRepFocus(id); setTab('reps'); };

  return (
    <div className="ad-shell">
      <aside className="side">
        <div className="brand"><span className="brand-name">Hans</span><span className="brand-sub">Admin</span></div>
        {TABS.map((t) => (
          <button key={t.id} className={'nav' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <t.icon />{t.label}
            {t.id === 'reps' && reps.data && <b>{reps.data.length}</b>}
          </button>
        ))}
        <div className="ad-foot">Admin workspace<br />Reporting days use India Standard Time.</div>
      </aside>

      <main className="ad-main">
        <header className="topbar">
          <h1>{tab === 'reps' && repFocus && reps.data ? (reps.data.find((r) => r.id === repFocus)?.email.split('@')[0] ?? TITLES[tab]) : TITLES[tab]}</h1>
          <span className="ad-clock">{clock}</span>
          <span className="ad-who"><span className="ad-pill blue">admin</span>{me.email}
            <button className="btn btn-ghost" onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut /></button></span>
        </header>

        {showFilters && (
          <div className="ad-filters">
            <span className="ad-lbl">Period</span>
            <div className="ad-seg">
              {PERIODS.map((p) => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => setFilters({ period: p.id, from: filters.from || istToday(), to: filters.to || istToday() })}>{p.label}</button>)}
            </div>
            {period === 'custom' && (
              <>
                <input type="date" value={filters.from} max={istToday()} onChange={(e) => setFilters({ from: e.target.value })} aria-label="From" />
                <span className="muted">to</span>
                <input type="date" value={filters.to} max={istToday()} onChange={(e) => setFilters({ to: e.target.value })} aria-label="To" />
              </>
            )}
            <span className="ad-lbl">Segment</span>
            <div className="ad-seg">
              {([['all', 'All'], ['non_india', 'Non-India'], ['india', 'India']] as [Segment, string][]).map(([id, label]) => (
                <button key={id} className={filters.segment === id ? 'on' : ''} onClick={() => setFilters({ segment: id })}>{label}</button>))}
            </div>
            {tab !== 'reps' && (
              <>
                <span className="ad-lbl">Rep</span>
                <select value={filters.rep ?? ''} onChange={(e) => setFilters({ rep: e.target.value ? Number(e.target.value) : null })} aria-label="Rep">
                  <option value="">All reps</option>
                  {(reps.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.email.split('@')[0]}</option>)}
                </select>
              </>
            )}
            <span className="ad-note">{note}</span>
          </div>
        )}

        {tab === 'overview' && <Overview filters={filters} tick={tick} onRep={openRep} />}
        {tab === 'reps' && <Reps filters={filters} tick={tick} reps={reps.data ?? []} focus={repFocus} onFocus={setRepFocus} onLead={setOpenLead} />}
        {tab === 'calls' && <Calls filters={filters} tick={tick} onLead={setOpenLead} />}
        {tab === 'leads' && <Leads filters={filters} tick={tick} onLead={setOpenLead} />}
        {tab === 'wallet' && <Wallet tick={tick} />}
        {tab === 'users' && <UsersScreen me={me} tick={tick} />}
      </main>

      {openLead != null && <LeadDrawer id={openLead} tick={tick} onClose={() => setOpenLead(null)} />}
    </div>
  );
}
