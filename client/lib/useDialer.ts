import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { API, api, post } from './api';
import { useSoftphone } from './useSoftphone';

export type Me = { id: number; email: string; phone: string | null };
export type Card = {
  callId: number; leadId: number; name: string | null; phone: string; country: string | null; segment: string;
  utcOffset: string | number | null; hubspotId: string | null; extra: LeadExtra; attempt: number; lastOutcome: string | null; lastNote: string | null;
};
export type LeadExtra = { email?: string; company?: string; leadStage?: string; lifecycle?: string; origin?: string; title?: string; hubspotUrl?: string; priority?: number };
export type Stats = { dialed_today: number; connected_today: number; talk_seconds_today: number; queued: number };
export type LastCall = { phone: string; name: string | null; from: string | null; at: Date; outcome: string | null };
export type LegStatus = 'ringing' | 'answered' | 'cancelled';
export type Leg = { leadId: number; name: string | null; phone: string; country: string | null; from: string; status: LegStatus };
export type NextLead = { id: number; name: string | null; phone: string; country: string | null; segment: string; utc_offset: string | null; attempt_count: number; status: string; last_outcome: string | null; extra: LeadExtra };
export type FromNumber = { number: string; region: 'india' | 'eu' | 'us'; usedToday: number; cap: number; available: boolean };
export type Rep = 'disconnected' | 'ringing' | 'connected';
export type Phase = 'idle' | 'ringing' | 'live' | 'ended';
export type Outcome = 'connected' | 'no_answer' | 'later';
export type EventKind = 'sys' | 'dialing' | 'answered' | 'connected' | 'no_answer' | 'later' | 'cancelled' | 'failed' | 'ended' | 'error';
export type ActivityEvent = { id: string; at: Date; kind: EventKind; text: string; sub?: string; phone?: string };
type SessionState = { repUp: boolean; burstId: number | null };
type ImportResult = { inserted: number; updated: number; skipped: { line: number; reason: string }[]; warnings: { line: number; reason: string }[] };
type ActivityRow = { callId: number; name: string | null; phone: string; country: string | null; from: string | null; startedAt: string; answered: boolean; duration: number | null; disposition: string | null; notes: string | null; burstWon: boolean };

const label = (name: string | null, phone: string) => name || phone;
const FEED_MAX = 200;
let seq = 0;

/** Today's calls from the server become feed entries, so a page reload loses nothing. */
function rowEvent(r: ActivityRow): ActivityEvent {
  const who = label(r.name, r.phone);
  const at = new Date(r.startedAt);
  const id = 'c' + r.callId;
  switch (r.disposition) {
    case 'connected': return { id, at, kind: 'connected', text: who, sub: `connected · ${r.duration ?? 0}s${r.notes ? ' · ' + r.notes : ''}` };
    case 'later': return { id, at, kind: 'later', text: who, sub: `call later${r.notes ? ' · ' + r.notes : ''}` };
    case 'no_answer': return { id, at, kind: 'no_answer', text: who, sub: r.answered ? `answered ${r.duration ?? 0}s, marked no answer` : 'no answer' };
    case 'cancelled': return { id, at, kind: 'cancelled', text: who, sub: r.burstWon ? 'cancelled — other lead answered first' : 'cancelled — dialing stopped' };
    case 'abandoned': return { id, at, kind: 'failed', text: who, sub: 'abandoned — answered while another lead was already on' };
    case 'failed': return { id, at, kind: 'failed', text: who, sub: 'could not be dialed' };
    default:
      if (r.answered && r.duration != null) return { id, at, kind: 'ended', text: who, sub: `ended ${r.duration}s — no outcome saved` };
      return { id, at, kind: r.answered ? 'answered' : 'dialing', text: who, sub: r.answered ? 'on the line' : 'ringing' };
  }
}

const rowToEvent = (r: ActivityRow): ActivityEvent => ({ ...rowEvent(r), phone: r.phone });

/** All dialer state + Socket.IO wiring. Components are markup only. Audio is browser-only in the UI;
 *  the server still supports phone mode as the plan's fallback (mode:'phone' on /connect). */
export function useDialer(me: Me) {
  const softphone = useSoftphone();
  const [rep, setRep] = useState<Rep>('disconnected');
  const [phase, setPhase] = useState<Phase>('idle');
  const [legs, setLegs] = useState<Leg[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [answeredAt, setAnsweredAt] = useState<Date | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [fromNumbers, setFromNumbers] = useState<FromNumber[]>([]);
  const [upNext, setUpNext] = useState<NextLead[] | null>(null); // null = loading
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');                       // shared by the handset Note tile and the Stage card
  const [lastCall, setLastCall] = useState<LastCall | null>(null); // the handset's "last call" strip + redial
  const [prefill, setPrefill] = useState<string | null>(null);   // a number handed to the handset from Up next / Activity (tap-to-dial)

  const push = useCallback((kind: EventKind, text: string, sub?: string, phone?: string) =>
    setFeed((f) => [{ id: 'e' + (++seq), at: new Date(), kind, text, sub, phone }, ...f].slice(0, FEED_MAX)), []);
  const sys = useCallback((text: string) => push('sys', text), [push]);

  const refresh = useCallback(() => {
    api<Stats>('/api/leads/stats').then(setStats).catch(() => {});
    api<FromNumber[]>('/api/session/from-numbers').then(setFromNumbers).catch(() => {});
    api<NextLead[]>('/api/leads/next?n=10').then(setUpNext).catch(() => {});
  }, []);

  useEffect(() => {
    api<SessionState>('/api/session/state')
      .then((s) => { setRep(s.repUp ? 'connected' : 'disconnected'); if (s.burstId) setPhase('ringing'); })
      .catch(() => {});
    api<ActivityRow[]>('/api/leads/activity')
      .then((rows) => {
        const last = rows[rows.length - 1];
        if (last) setLastCall({ phone: last.phone, name: last.name, from: last.from, at: new Date(last.startedAt), outcome: last.disposition });
        setFeed((live) => [...live.filter((e) => e.kind === 'sys'), ...rows.map(rowToEvent).reverse()].slice(0, FEED_MAX));
      })
      .catch(() => {}).finally(() => setFeedLoaded(true));
    refresh();

    const socket = io(API || undefined, { withCredentials: true });
    socket.on('connect', () => sys('live updates connected'));
    socket.on('disconnect', () => sys('live updates lost — reconnecting'));
    socket.on('rep:ringing', () => { setRep('ringing'); sys('connecting your audio'); });
    socket.on('rep:connected', () => { setRep('connected'); sys('audio connected — you hear silence until a lead answers'); });
    // A live/ended card survives a drop so the rep can still disposition it; only a ringing burst resets.
    socket.on('rep:disconnected', (p: { cause?: string }) => {
      setRep('disconnected'); setPhase((ph) => (ph === 'ringing' ? 'idle' : ph)); setLegs([]);
      push('error', 'audio dropped', p?.cause ?? 'unknown cause');
    });
    socket.on('burst:started', (p: { legs: Omit<Leg, 'status'>[] }) => {
      setLegs(p.legs.map((l) => ({ ...l, status: 'ringing' }))); setCard(null); setDuration(null); setAnsweredAt(null); setPhase('ringing'); setNote('');
      setLastCall({ phone: p.legs[0].phone, name: p.legs[0].name, from: p.legs[0].from, at: new Date(), outcome: null });
      push('dialing', p.legs.map((l) => label(l.name, l.phone)).join('  ·  '), `dialing ${p.legs.length} lead${p.legs.length === 1 ? '' : 's'}`, p.legs.length === 1 ? p.legs[0].phone : undefined);
    });
    socket.on('lead:answered', (c: Card) => {
      setCard(c); setPhase('live'); setAnsweredAt(new Date());
      setLastCall((lc) => ({ phone: c.phone, name: c.name, from: lc?.from ?? null, at: lc?.at ?? new Date(), outcome: null }));
      setLegs((ls) => ls.map((l) => ({ ...l, status: l.leadId === c.leadId ? 'answered' : 'cancelled' })));
      push('answered', label(c.name, c.phone), 'answered', c.phone);
    });
    socket.on('call:bridged', () => sys('bridged — you are on the line'));
    socket.on('call:ended', (p: { duration: number | null }) => {
      setDuration(p.duration); setPhase((ph) => (ph === 'live' ? 'ended' : ph));
      push('ended', 'call ended', `${p.duration ?? '?'}s — pick an outcome`); refresh();
    });
    socket.on('call:error', (p: { error: string }) => { setErr(p.error); setPhase('ended'); push('error', p.error); });
    socket.on('burst:ended', (p: { result?: string }) => {
      setPhase('idle'); setLegs([]);
      push(p?.result === 'cancelled' ? 'cancelled' : 'no_answer', p?.result === 'cancelled' ? 'dialing stopped' : 'nobody answered');
      refresh();
    });
    return () => { socket.disconnect(); };
  }, [push, sys, refresh]);

  // Plan s8 detail 3: the softphone socket dying is a dropped rep leg. Say so, never fail silently.
  useEffect(() => {
    if (softphone.status === 'off' && rep === 'connected') { setRep('disconnected'); push('error', 'audio dropped', 'softphone disconnected — connect again'); }
  }, [softphone.status, rep, push]);

  const run = useCallback(async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { const m = (e as Error).message; setErr(m); push('error', what + ' failed', m); }
    finally { setBusy(false); }
  }, [push]);

  return {
    me, rep, phase, legs, card, answeredAt, duration, stats, fromNumbers, upNext, feed, feedLoaded, busy, err, softphone, note, setNote, lastCall, prefill, setPrefill,
    connect: () => run('connect audio', async () => {
      const { token } = await post<{ token: string }>('/api/session/webrtc-token');
      await softphone.connect(token);
      await post('/api/session/connect', { mode: 'browser' });
    }),
    // Browser hangs up first so the SDK never BYEs a leg the server already ended; the server call then just clears state.
    disconnect: () => run('disconnect audio', async () => { softphone.disconnect(); await post('/api/session/disconnect'); }),
    startCalling: () => run('start calling', () => post('/api/session/burst')),
    manualDial: (to: string, from: string) => run('call', () => post('/api/session/dial', { to, from })),
    hangupLead: () => run('hang up', () => post('/api/session/hangup-lead')),
    // DTMF while bridged (IVR menus, extensions). Not through run(): a keypress must never flip `busy`.
    sendDtmf: (digits: string) => post('/api/session/dtmf', { digits }).catch((e) => setErr((e as Error).message)),
    disposition: (outcome: Outcome, opts: { laterAt?: string; notes?: string } = {}) => run('save outcome', async () => {
      if (!card) return;
      await post('/api/session/disposition', {
        callId: card.callId, outcome, notes: (opts.notes ?? note) || undefined,
        laterAt: opts.laterAt ? new Date(opts.laterAt).toISOString() : undefined,
      });
      const who = label(card.name, card.phone);
      push(outcome, who, { connected: 'connected', no_answer: 'no answer', later: 'call later' }[outcome] + (opts.notes ? ' · ' + opts.notes : ''), card.phone);
      setCard(null); setDuration(null); setAnsweredAt(null); setPhase('idle'); setLegs([]); refresh();
      setNote(''); setLastCall((lc) => lc && { ...lc, outcome });
    }),
    upload: (file: File) => run('import', async () => {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<ImportResult>('/api/leads/import', { method: 'POST', body: fd });
      sys(`imported ${r.inserted} new, ${r.updated} updated, ${r.skipped.length} skipped, ${r.warnings.length} warnings`);
      for (const s of [...r.skipped, ...r.warnings].slice(0, 5)) sys(`line ${s.line}: ${s.reason}`);
      refresh();
    }),
  };
}
