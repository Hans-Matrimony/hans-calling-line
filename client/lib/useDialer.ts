import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API, api, post, patch } from './api';
import { SUB_OUTCOME_LABEL, describePull } from './format';
import { useSoftphone } from './useSoftphone';

export type Me = { id: number; email: string; phone: string | null; role?: 'rep' | 'admin' };
export type Card = {
  callId: number; leadId: number; name: string | null; phone: string; country: string | null; segment: string;
  utcOffset: string | number | null; timezone?: string | null; attemptLimit: number; hubspotId: string | null; extra: LeadExtra; attempt: number; lastOutcome: string | null; lastNote: string | null;
  lastCallAt: string | null; everConnected: boolean | null; callCount: number; // history summary shown on the card
  phones: string[]; phoneIdx: number; // the lead's numbers in cascade order, and which one is in play
};
export type HistoryRow = { callId: number; at: string; answered: boolean; duration: number | null; disposition: string | null; subOutcome: string | null; reason: string | null; notes: string | null };
export type LeadExtra = { email?: string; company?: string; leadStage?: string; lifecycle?: string; origin?: string; title?: string; linkedin?: string; hubspotUrl?: string; priority?: number };
export type Stats = { dialed_today: number; connected_today: number; talk_seconds_today: number; queued: number; ready: number; next_open_at: string | null; waiting_gap: number; waiting_window: number; hubspot?: HubSpot };
/** The HubSpot inlet's health, for the Up next strip. `configured` false = no token on the server, so the
 *  strip stays hidden and CSV is the only inlet. `ok` false means the inlet itself is broken (bad token,
 *  missing scope, the checkbox property was never created) — always shown, unlike per-contact rejects. */
export type HubSpot = { configured: boolean; ok?: boolean | null; error?: string | null; syncedAt?: string | null; inQueue?: number; lastChange?: SyncResult | null };
/** What one pull did. `at` is set on the copy the server keeps as the rep's last change (and on the queue:synced event). */
export type SyncResult = { added: number; resumed: number; reopened: number; removed: number; skipped: number; refreshed?: number; ticked: number; syncedAt: string; at?: string };
export type LastCall = { phone: string; name: string | null; from: string | null; at: Date; outcome: string | null };
export type LegStatus = 'ringing' | 'answered' | 'cancelled' | 'abandoned';
export type Leg = { leadId: number; name: string | null; phone: string; country: string | null; from: string; status: LegStatus; card?: Card };
export type NextLead = { id: number; name: string | null; phone: string; phones: string[]; country: string | null; segment: string; utc_offset: string | null; timezone?: string | null; attemptLimit: number; attempt_count: number; status: string; next_call_at: string; last_outcome: string | null; lastCallAt: string | null; everConnected: boolean | null; extra: LeadExtra; phoneIdx: number; phoneCount: number };
/** The one rule holding a lead back (server queue.js WHY), or null when it is due now. */
export type QueueWhy = 'gap' | 'hour' | 'window' | 'later' | 'no_timezone' | null;
export type QueueLead = NextLead & { opensAt: string; why: QueueWhy };
/** One head on Up next: 'ready', 'window:<instant>' (one per opening time), or the why word. */
export type QueueGroup = { retryMinutes?: number | null; key: string; why: QueueWhy; opensAt: string | null; count: number; countries: string[]; leads: QueueLead[] };
export type QueueOverview = { now: string; total: number; ready: QueueGroup; later: QueueGroup[]; soonest: string | null };
export type LeadPatch = { name?: string; company?: string; title?: string; email?: string; linkedin?: string; leadStage?: string; phones?: string[] };
export type FromNumber = { number: string; region: 'india' | 'eu' | 'us'; usedToday: number; cap: number; available: boolean };
export type Rep = 'disconnected' | 'ringing' | 'connected';
export type Phase = 'idle' | 'ringing' | 'live' | 'ended';
export type Outcome = 'connected' | 'no_answer' | 'later' | 'invalid';
export type EventKind = 'sys' | 'dialing' | 'answered' | 'connected' | 'no_answer' | 'later' | 'cancelled' | 'failed' | 'ended' | 'error';
export type ActivityEvent = { id: string; at: Date; kind: EventKind; text: string; sub?: string; phone?: string; company?: string };
export type Mode = 'auto' | 'burst';
export type Run = { mode: Mode; since: Date; endAfter: boolean };
export type LastRun = { mode: Mode; since: Date; until: Date };
export type SavedCall = { card: Card; label: string; note: string; status: string; nextCallAt: string | null; duration: number | null };
export type HeldBack = { name: string | null; phone: string; at: string };
type SessionState = { repUp: boolean; burstId: number | null; phase: Phase; legs: Leg[]; card: Card | null; answeredAt: string | null; duration: number | null };
type BurstLeg = { leadId: number; name: string | null; phone: string; disposition: string | null };
export type ImportResult = { inserted: number; updated: number; withAlternates: number; skipped: { line: number; reason: string }[]; warnings: { line: number; reason: string }[] };
type ActivityRow = { callId: number; name: string | null; phone: string; country: string | null; from: string | null; startedAt: string; answered: boolean; duration: number | null; disposition: string | null; subOutcome: string | null; notes: string | null; burstWon: boolean };

const label = (name: string | null, phone: string) => name || phone;
const FEED_MAX = 200;
let seq = 0;
const OUTCOME_TEXT: Record<Outcome, string> = { connected: 'Connected', no_answer: 'No answer', later: 'Call later', invalid: 'Wrong number' };

/** The feed/tape kind for a settled outcome, chosen so the run tape colours by the sub-outcome the rep
 *  picked (call-card v2) while reusing the existing tile colours: a connected 'Not interested' reads
 *  coral, a booked follow-up reads blue, without Campaign needing new colours. */
function feedKind(outcome: Outcome | string, sub?: string | null): EventKind {
  if (sub === 'follow_up' || sub === 'callback') return 'later';
  if (sub === 'not_interested') return 'failed';
  if (sub === 'not_qualified') return 'no_answer';
  if (sub === 'interested') return 'connected';
  return outcome === 'invalid' ? 'failed' : (outcome as EventKind);
}

/** Today's calls from the server become feed entries, so a page reload loses nothing. */
function rowEvent(r: ActivityRow): ActivityEvent {
  const who = label(r.name, r.phone);
  const at = new Date(r.startedAt);
  const id = 'c' + r.callId;
  switch (r.disposition) {
    case 'connected': {
      const lbl = (r.subOutcome && SUB_OUTCOME_LABEL[r.subOutcome]) || 'Connected';
      return { id, at, kind: feedKind('connected', r.subOutcome), text: who, sub: `${lbl} · ${r.duration ?? 0}s${r.notes ? ' · ' + r.notes : ''}` };
    }
    case 'later': return { id, at, kind: 'later', text: who, sub: `Call later${r.notes ? ' · ' + r.notes : ''}` };
    case 'no_answer': return { id, at, kind: 'no_answer', text: who, sub: r.answered ? `Answered ${r.duration ?? 0}s, saved as no answer` : 'No answer' };
    case 'cancelled': return { id, at, kind: 'cancelled', text: who, sub: r.burstWon ? 'Cancelled — the other lead answered first' : 'Cancelled — dialing stopped' };
    case 'abandoned': return { id, at, kind: 'failed', text: who, sub: 'Picked up while you were already connecting — counts as an attempt' };
    case 'invalid': return { id, at, kind: 'failed', text: who, sub: 'Wrong number' };
    case 'failed': return { id, at, kind: 'failed', text: who, sub: 'Could not be dialed' };
    default:
      if (r.answered && r.duration != null) return { id, at, kind: 'ended', text: who, sub: `Ended ${r.duration}s — no outcome saved` };
      return { id, at, kind: r.answered ? 'answered' : 'dialing', text: who, sub: r.answered ? 'On the line' : 'Ringing' };
  }
}
const rowToEvent = (r: ActivityRow): ActivityEvent => ({ ...rowEvent(r), phone: r.phone });

/** All dialer state + Socket.IO wiring. Components are markup only. Audio is browser-only in the UI;
 *  the server still supports phone mode as the plan's fallback (mode:'phone' on /connect).
 *  Call state is rebuilt from /api/session/state on load and on every socket reconnect, so a reload,
 *  a tab switch or a server restart never strands a call. */
export function useDialer(me: Me) {
  const softphone = useSoftphone();
  const [recovered, setRecovered] = useState(false);
  const [rep, setRep] = useState<Rep>('disconnected');
  const [phase, setPhase] = useState<Phase>('idle');
  const [legs, setLegs] = useState<Leg[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [answeredAt, setAnsweredAt] = useState<Date | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [endCause, setEndCause] = useState<string | null>(null);   // why the last call ended: rep_hangup | bridge_failed | a Telnyx cause
  const [stats, setStats] = useState<Stats | null>(null);
  const [fromNumbers, setFromNumbers] = useState<FromNumber[]>([]);
  const [upNext, setUpNext] = useState<NextLead[] | null>(null); // null = loading
  const [queue, setQueue] = useState<QueueOverview | null>(null); // the whole queue, grouped by when each lead opens (Up next tab)
  const expandedRef = useRef<Set<string>>(new Set());              // groups the rep opened in full; re-sent on every refresh so "Show all" survives the minute poll
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState('');                             // shared by the handset Note tile and the lead card
  const [callerName, setCallerName] = useState('');                 // unknown-number capture: who this manual dial turned out to be
  const [callerCompany, setCallerCompany] = useState('');
  const [lastCall, setLastCall] = useState<LastCall | null>(null); // the handset's "last call" strip + redial
  const [lastSaved, setLastSaved] = useState<SavedCall | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);     // a number handed to the handset from Up next / Activity (tap-to-dial)
  // Auto dial / Burst dial run. Lives here, not in the page, so switching tabs or a lead answering elsewhere keeps it.
  const [run, setRun] = useState<Run | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [runTape, setRunTape] = useState<ActivityEvent[]>([]);     // one row per lead dialed this run, in order (never manual calls)
  const [lastBurst, setLastBurst] = useState<{ result: string; names: string[] } | null>(null); // how the last burst of the run ended
  const [heldBack, setHeldBack] = useState<HeldBack[]>([]);        // Burst dial rang fewer leads than asked: who is cooling down
  const runRef = useRef<Run | null>(null); runRef.current = run;
  const manualRef = useRef(false);                                 // the burst in flight came from the manual keypad
  const phaseRef = useRef<Phase>('idle'); phaseRef.current = phase;
  const answeredRef = useRef<Date | null>(null); answeredRef.current = answeredAt;
  const draftCall = useRef<number | null>(null);

  // Keep an unsaved note through reloads in this tab, scoped to this rep and call.
  useEffect(() => {
    if (!card) { draftCall.current = null; return; }
    const key = `eazybe.note.${me.id}.${card.callId}`;
    try {
      if (draftCall.current !== card.callId) {
        draftCall.current = card.callId;
        const saved = sessionStorage.getItem(key);
        if (saved !== null) { setNote(saved); return; }
      }
      sessionStorage.setItem(key, note);
    } catch { /* Storage can be unavailable in private browsing. The in-memory note still works. */ }
  }, [card, note, me.id]);

  const push = useCallback((kind: EventKind, text: string, sub?: string, phone?: string) =>
    setFeed((f) => [{ id: 'e' + (++seq), at: new Date(), kind, text, sub, phone }, ...f].slice(0, FEED_MAX)), []);
  const sys = useCallback((text: string) => push('sys', text), [push]);
  /** A feed row that also lands on the run's tape (when a run is on and the call was not a manual dial). */
  const tapePush = useCallback((kind: EventKind, text: string, sub?: string, phone?: string, company?: string) => {
    const e: ActivityEvent = { id: 'e' + (++seq), at: new Date(), kind, text, sub, phone, company };
    setFeed((f) => [e, ...f].slice(0, FEED_MAX));
    if (runRef.current && !manualRef.current) setRunTape((t) => [...t, e]);
  }, []);

  const refreshQueue = useCallback(() => {
    const groups = [...expandedRef.current].map((k) => '&group=' + encodeURIComponent(k)).join('');
    api<QueueOverview>('/api/leads/queue?per=5' + groups).then(setQueue).catch((e) => setLoadError('Couldn’t refresh the queue: ' + (e as Error).message));
  }, []);
  const refresh = useCallback(() => {
    setLoadError(null);
    Promise.all([
      api<Stats>('/api/leads/stats').then(setStats),
      api<FromNumber[]>('/api/session/from-numbers').then(setFromNumbers),
      api<NextLead[]>('/api/leads/next?n=10').then(setUpNext),
    ]).catch((e) => setLoadError('Couldn’t refresh calling data: ' + (e as Error).message));
    refreshQueue();
  }, [refreshQueue]);

  /** Rebuild the call from the server's view of it. */
  const sync = useCallback(() => api<SessionState>('/api/session/state').then((s) => {
    setRecovered(true);
    setRep(s.repUp ? 'connected' : 'disconnected');
    setPhase(s.phase); setLegs(s.legs ?? []); setCard(s.card ?? null);
    setAnsweredAt(s.answeredAt ? new Date(s.answeredAt) : null); setDuration(s.duration ?? null);
  }).catch((e) => setLoadError('Couldn’t restore your call: ' + (e as Error).message)), []);

  useEffect(() => {
    sync();
    api<ActivityRow[]>('/api/leads/activity')
      .then((rows) => {
        const last = rows[rows.length - 1];
        if (last) setLastCall({ phone: last.phone, name: last.name, from: last.from, at: new Date(last.startedAt), outcome: last.disposition });
        setFeed((live) => [...live.filter((e) => e.kind === 'sys'), ...rows.map(rowToEvent).reverse()].slice(0, FEED_MAX));
      })
      .catch(() => {}).finally(() => setFeedLoaded(true));
    refresh();

    const socket = io(API || undefined, { withCredentials: true });
    let first = true;
    socket.on('connect', () => { sys('Live updates on'); if (!first) { sync(); refresh(); } first = false; }); // a reconnect may have missed events
    socket.on('disconnect', () => sys('Live updates lost — reconnecting'));
    socket.on('rep:ringing', () => { setRep('ringing'); sys('Connecting your audio…'); });
    socket.on('rep:connected', () => { setRep('connected'); sys('Audio on — a soft tick while it dials, a rising beep when someone answers, a low double beep when nobody does'); });
    // A live/ended card survives a drop so the rep can still save its outcome; only a ringing burst resets.
    socket.on('rep:disconnected', (p: { cause?: string }) => {
      setRep('disconnected'); setPhase((ph) => (ph === 'ringing' ? 'idle' : ph)); setLegs([]);
      push('error', 'Audio dropped', p?.cause ?? 'unknown cause');
    });
    socket.on('burst:started', (p: { legs: Omit<Leg, 'status'>[]; manual?: boolean; heldBack?: HeldBack[] }) => {
      manualRef.current = !!p.manual;
      setLastSaved(null);
      setLegs(p.legs.map((l) => ({ ...l, status: 'ringing' }))); setCard(null); setDuration(null); setAnsweredAt(null); setEndCause(null); setPhase('ringing'); setNote(''); setCallerName(''); setCallerCompany('');
      setLastBurst(null); setHeldBack(p.heldBack ?? []);
      setLastCall({ phone: p.legs[0].phone, name: p.legs[0].name, from: p.legs[0].from, at: new Date(), outcome: null });
      push('dialing', p.legs.map((l) => label(l.name, l.phone)).join('  ·  '), `Dialing ${p.legs.length} lead${p.legs.length === 1 ? '' : 's'}`, p.legs.length === 1 ? p.legs[0].phone : undefined);
    });
    socket.on('lead:answered', (c: Card) => {
      setCard(c); setPhase('live'); setAnsweredAt(new Date()); setEndCause(null);
      setLastCall((lc) => ({ phone: c.phone, name: c.name, from: lc?.from ?? null, at: lc?.at ?? new Date(), outcome: null }));
      setLegs((ls) => ls.map((l) => ({ ...l, status: l.leadId === c.leadId ? 'answered' : 'cancelled' })));
      push('answered', label(c.name, c.phone), 'Answered', c.phone);
    });
    socket.on('lead:abandoned', (p: { leadId: number; name: string | null; phone: string }) => {
      setLegs((ls) => ls.map((l) => (l.leadId === p.leadId ? { ...l, status: 'abandoned' } : l)));
      tapePush('failed', label(p.name, p.phone), 'Picked up while you were already connecting — counts as an attempt; retry time is shown in Up next', p.phone);
    });
    socket.on('lead:failed', (p: { name: string | null; phone: string; error: string }) => {
      tapePush('failed', label(p.name, p.phone), p.error, p.phone); // the server says why, and whether the lead comes back
    });
    socket.on('call:bridged', () => sys('On the line'));
    // A HubSpot pull changed this rep's queue (a tick, an untick): say what arrived and show it, no reload.
    socket.on('queue:synced', (c: SyncResult) => { sys('HubSpot: ' + describePull(c)); refresh(); });
    socket.on('queue:changed', refresh);
    socket.on('call:ended', (p: { callId: number; duration: number | null; cause?: string }) => {
      // The red button and the hangup webhook both report this call: one row, one refresh.
      const id = 'end' + p.callId;
      let fresh = false;
      setFeed((f) => { if (f.some((e) => e.id === id)) return f; fresh = true; return [{ id, at: new Date(), kind: 'ended' as const, text: 'Call ended', sub: `${p.duration ?? '?'}s — save the outcome` }, ...f].slice(0, FEED_MAX); });
      setEndCause(p.cause ?? null); setDuration((d) => d ?? p.duration);
      setPhase((ph) => (ph === 'idle' ? ph : 'ended'));
      if (fresh) refresh();
    });
    socket.on('call:error', (p: { error: string }) => { setErr(p.error); setPhase('ended'); push('error', p.error); });
    socket.on('burst:ended', (p: { result?: string; legs?: BurstLeg[] }) => {
      setPhase('idle'); setLegs([]);
      setRun((r) => { if (r?.endAfter) { setLastRun({ mode: r.mode, since: r.since, until: new Date() }); return null; } return r; });
      const stopped = p?.result === 'cancelled';
      const rows = p.legs ?? [];
      for (const l of rows) {
        const kind: EventKind = l.disposition === 'cancelled' ? 'cancelled' : l.disposition === 'failed' ? 'failed' : 'no_answer';
        tapePush(kind, label(l.name, l.phone), kind === 'cancelled' ? 'Dialing stopped' : kind === 'failed' ? 'Could not be dialed' : 'No answer', l.phone);
      }
      if (!rows.length) tapePush(stopped ? 'cancelled' : 'no_answer', stopped ? 'Dialing stopped' : 'Nobody answered');
      setLastBurst({ result: stopped ? 'cancelled' : 'no_answer', names: rows.map((l) => label(l.name, l.phone)) });
      // The handset's "last call" strip: nobody answered, so no outcome step follows - say so there instead of leaving "dialed".
      setLastCall((lc) => lc && !lc.outcome ? { ...lc, outcome: stopped ? 'cancelled' : 'no_answer' } : lc);
      refresh();
    });
    return () => { socket.disconnect(); };
  }, [push, sys, tapePush, refresh, sync]);

  // Plan s8 detail 3: the softphone socket dying is a dropped rep leg. Say so, never fail silently.
  useEffect(() => {
    if (softphone.status === 'off' && rep === 'connected') { setRep('disconnected'); push('error', 'Audio dropped', 'connect again from the top bar'); }
  }, [softphone.status, rep, push]);

  // Between dials nothing else moves the queue: a lead's 2h gap ends, a clock reaches 10:00. Poll once a minute while idle.
  useEffect(() => {
    if (phase !== 'idle') return;
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [phase, refresh]);

  const runCmd = useCallback(async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setErr(null);
    try { return await fn(); }
    catch (e) {
      const m = (e as Error).message;
      if (/audio is not connected|audio leg is not connected/i.test(m)) setRep('disconnected'); // server lost the leg (restart): let Connect reappear
      setErr(m); push('error', what + ' failed', m); return undefined;
    }
    finally { setBusy(false); }
  }, [push]);

  return {
    me, rep, recovered, phase, legs, card, answeredAt, duration, endCause, stats, fromNumbers, upNext, queue, feed, feedLoaded, busy, err, loadError, softphone,
    retryLoad: () => { refresh(); void sync(); },
    note, setNote, lastCall, lastSaved, dismissSaved: () => setLastSaved(null), prefill, setPrefill, run, lastRun, runTape, lastBurst, heldBack,
    /** "Show all N" on an Up next group: fetch it in full, and keep it open across refreshes. */
    expandGroup: (key: string) => { expandedRef.current.add(key); refreshQueue(); },
    startRun: (mode: Mode) => { if (!runRef.current) { setRunTape([]); setLastBurst(null); setRun({ mode, since: new Date(), endAfter: false }); } },
    stopRun: () => setRun((r) => { if (r) setLastRun({ mode: r.mode, since: r.since, until: new Date() }); return null; }),
    endRunAfterCall: () => setRun((r) => (r ? { ...r, endAfter: true } : r)),
    connect: () => runCmd('connect audio', async () => {
      const { token } = await post<{ token: string }>('/api/session/webrtc-token');
      await softphone.connect(token);
      await post('/api/session/connect', { mode: 'browser' });
    }),
    // Browser hangs up first so the SDK never BYEs a leg the server already ended; the server call then just clears state.
    disconnect: () => runCmd('disconnect audio', async () => { softphone.disconnect(); await post('/api/session/disconnect'); }),
    /** legs 1 = Auto dial (one lead), 2 = Burst dial (first to answer wins). 'drained' = nobody is due, which is a
     *  state to explain, not an error to show in red. undefined = the server refused for a real reason (shown in err). */
    startCalling: (legs: 1 | 2): Promise<'started' | 'drained' | undefined> => runCmd('start dialing', async () => {
      try { await post('/api/session/burst', { legs }); return 'started' as const; }
      catch (e) {
        if (/nobody is due/i.test((e as Error).message)) { sys('Queue drained — nobody is due right now'); refresh(); return 'drained' as const; }
        throw e;
      }
    }),
    manualDial: (to: string, from: string) => runCmd('call', () => post('/api/session/dial', { to, from })),
    // If the server has nothing to hang up while we show a live card (its burst was cleared), end the call locally
    // so the outcome buttons appear instead of a dead red button.
    hangupLead: () => runCmd('hang up', () => post('/api/session/hangup-lead')).then((r) => {
      if (r === undefined && phaseRef.current === 'live') {
        setDuration(answeredRef.current ? Math.floor((Date.now() - answeredRef.current.getTime()) / 1000) : 0);
        setPhase('ended'); setErr(null);
      }
    }),
    // DTMF while bridged (IVR menus, extensions). Not through runCmd(): a keypress must never flip `busy`.
    sendDtmf: (digits: string) => post('/api/session/dtmf', { digits }).catch((e) => setErr((e as Error).message)),
    callerName, setCallerName, callerCompany, setCallerCompany,
    leadHistory: (leadId: number) => api<HistoryRow[]>(`/api/leads/${leadId}/history`),
    // Only show contact changes as saved after the server accepts and normalises them.
    patchLead: async (leadId: number, p: LeadPatch) => {
      const r = await patch<{ name: string | null; extra: LeadExtra; phones: string[]; phoneIdx: number }>(`/api/leads/${leadId}`, p);
      const update = (c: Card) => ({ ...c, ...r, phone: r.phones[r.phoneIdx - 1] ?? c.phone });
      setCard((c) => c && c.leadId === leadId ? update(c) : c);
      setLastSaved((s) => s && s.card.leadId === leadId ? { ...s, card: update(s.card) } : s);
      const fix = <L extends NextLead>(l: L): L => l.id === leadId
        ? { ...l, ...r, phone: r.phones[r.phoneIdx - 1] ?? l.phone, phoneCount: r.phones.length } : l;
      setUpNext((list) => list && list.map(fix));
      setQueue((qo) => qo && { ...qo, ready: { ...qo.ready, leads: qo.ready.leads.map(fix) }, later: qo.later.map((g) => ({ ...g, leads: g.leads.map(fix) })) });
    },
    disposition: (outcome: Outcome, opts: { laterAt?: string; notes?: string; subOutcome?: string; reason?: string } = {}) => runCmd('save outcome', async () => {
      if (!card) return;
      const saved = await post<{ status: string; retryMinutes: number | null; nextCallAt: string }>('/api/session/disposition', {
        callId: card.callId, outcome, subOutcome: opts.subOutcome, reason: opts.reason || undefined,
        notes: (opts.notes ?? note) || undefined,
        laterAt: opts.laterAt ? new Date(opts.laterAt).toISOString() : undefined,
        name: callerName.trim() || undefined, company: callerCompany.trim() || undefined,
      });
      const company = card.extra?.company || undefined;
      const who = callerName.trim() || card.name || company || label(null, card.phone);
      const n = (opts.notes ?? note).trim();
      const lbl = (opts.subOutcome && SUB_OUTCOME_LABEL[opts.subOutcome]) || OUTCOME_TEXT[outcome];
      const retry = saved.status === 'queued' && saved.retryMinutes ? `Retry after ${saved.retryMinutes} min, within calling hours` : saved.status === 'exhausted' ? 'Attempt limit reached' : '';
      const bits = [lbl, opts.reason, n, retry].filter(Boolean).join(' · ');
      tapePush(feedKind(outcome, opts.subOutcome), who, bits, card.phone, company && company !== who ? company : undefined);
      setLastSaved({ card: { ...card, name: callerName.trim() || card.name }, label: lbl, note: n, status: saved.status, nextCallAt: saved.nextCallAt, duration });
      try { sessionStorage.removeItem(`eazybe.note.${me.id}.${card.callId}`); } catch { /* optional tab storage */ }
      setCard(null); setDuration(null); setAnsweredAt(null); setEndCause(null); setPhase('idle'); setLegs([]); refresh();
      setNote(''); setCallerName(''); setCallerCompany(''); setLastCall((lc) => lc && { ...lc, outcome });
      setRun((r) => { if (r?.endAfter) { setLastRun({ mode: r.mode, since: r.since, until: new Date() }); return null; } return r; });
      return saved;
    }),
    // "Sync now" on Up next. Start dialing and opening Up next already pull on their own, so this is
    // the fallback for a rep who ticked something in HubSpot and does not want to wait even that long.
    syncNow: () => runCmd('sync with HubSpot', async () => {
      const r = await post<SyncResult>('/api/leads/sync');
      // A pull that changed something already reached the feed through queue:synced; only "nothing new" is ours to say.
      if (r.added + r.resumed + r.reopened + r.removed === 0) sys('HubSpot: ' + describePull(r));
      refresh();
      return r;
    }),
    upload: (file: File) => runCmd('import', async () => {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<ImportResult>('/api/leads/import', { method: 'POST', body: fd });
      sys(`Imported ${r.inserted} new, ${r.updated} updated, ${r.skipped.length} skipped, ${r.warnings.length} with no timezone`);
      for (const s of [...r.skipped, ...r.warnings].slice(0, 5)) sys(`Line ${s.line}: ${s.reason}`);
      refresh();
      return r;
    }),
  };
}
