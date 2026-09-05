import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { API, api, post } from './api';
import { useSoftphone } from './useSoftphone';

export type Me = { id: number; email: string; phone: string | null };
export type Card = { callId: number; leadId: number; name: string | null; phone: string; country: string | null; segment: string; attempt: number; lastOutcome: string | null };
export type Stats = { dialed_today: number; connected_today: number; queued: number };
export type Leg = { leadId: number; name: string | null; phone: string; country: string | null; from: string };
export type FromNumber = { number: string; region: 'india' | 'eu' | 'us'; usedToday: number; cap: number; available: boolean };
export type Rep = 'disconnected' | 'ringing' | 'connected';
export type Phase = 'idle' | 'ringing' | 'live' | 'ended';
export type Mode = 'phone' | 'browser';
export type Outcome = 'connected' | 'no_answer' | 'later';
export type LastCall = { phone: string; from: string; at: Date };
type SessionState = { repUp: boolean; burstId: number | null; audio_mode: Mode; phone: string | null };
type ImportResult = { inserted: number; updated: number; skipped: unknown[]; warnings: unknown[] };

/** All dialer state + Socket.IO wiring. The views in components/ are markup only. */
export function useDialer(me: Me) {
  const softphone = useSoftphone();
  const [phone, setPhone] = useState(me.phone ?? '');
  const [mode, setMode] = useState<Mode>('browser');
  const [rep, setRep] = useState<Rep>('disconnected');
  const [phase, setPhase] = useState<Phase>('idle');
  const [legs, setLegs] = useState<Leg[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [fromNumbers, setFromNumbers] = useState<FromNumber[]>([]);
  const [lastCall, setLastCall] = useState<LastCall | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const note = useCallback((s: string) => setLog((l) => [new Date().toLocaleTimeString() + '  ' + s, ...l].slice(0, 10)), []);
  const refreshStats = useCallback(() => {
    api<Stats>('/api/leads/stats').then(setStats).catch(() => {});
    api<FromNumber[]>('/api/session/from-numbers').then(setFromNumbers).catch(() => {});
  }, []);

  useEffect(() => {
    api<SessionState>('/api/session/state')
      .then((s) => { setRep(s.repUp ? 'connected' : 'disconnected'); if (s.burstId) setPhase('ringing'); if (s.audio_mode) setMode(s.audio_mode); })
      .catch(() => {});
    refreshStats();
    const socket = io(API || undefined, { withCredentials: true });
    socket.on('connect', () => note('live updates connected'));
    socket.on('disconnect', () => note('live updates lost, reconnecting'));
    socket.on('rep:ringing', (p: { mode?: Mode }) => { setRep('ringing'); note(p?.mode === 'browser' ? 'ringing your browser' : 'your phone is ringing'); });
    socket.on('rep:connected', () => { setRep('connected'); note('audio leg up, you should hear silence'); });
    // A live/ended card survives a drop so the rep can still disposition it; only a ringing burst resets.
    socket.on('rep:disconnected', (p: { cause?: string }) => { setRep('disconnected'); setPhase((ph) => (ph === 'ringing' ? 'idle' : ph)); note('audio leg dropped: ' + (p?.cause ?? 'unknown')); });
    socket.on('burst:started', (p: { legs: Leg[] }) => {
      setLegs(p.legs); setCard(null); setDuration(null); setPhase('ringing'); note('dialing ' + p.legs.length + ' lead(s)');
      if (p.legs[0]) setLastCall({ phone: p.legs[0].phone, from: p.legs[0].from, at: new Date() });
    });
    socket.on('lead:answered', (c: Card) => { setCard(c); setPhase('live'); note((c.name ?? c.phone) + ' answered'); });
    socket.on('call:bridged', () => note('bridged'));
    socket.on('call:ended', (p: { duration: number | null }) => { setDuration(p.duration); setPhase((ph) => (ph === 'live' ? 'ended' : ph)); note('call ended after ' + (p.duration ?? '?') + 's'); refreshStats(); });
    socket.on('call:error', (p: { error: string }) => { setErr(p.error); setPhase('ended'); note(p.error); });
    socket.on('burst:ended', (p: { result?: string }) => { setPhase('idle'); setLegs([]); note(p?.result === 'cancelled' ? 'call cancelled' : 'nobody answered'); refreshStats(); });
    return () => { socket.disconnect(); };
  }, [note, refreshStats]);

  // Plan s8 detail 3: the softphone socket dying is a dropped rep leg. Say so, never fail silently.
  useEffect(() => {
    if (mode === 'browser' && softphone.status === 'off' && rep === 'connected') { setRep('disconnected'); note('softphone disconnected - reconnect'); }
  }, [softphone.status, mode, rep, note]);

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { const m = (e as Error).message; setErr(m); note(label + ' failed: ' + m); }
    finally { setBusy(false); }
  }, [note]);

  return {
    phone, setPhone, mode, setMode, rep, phase, legs, card, duration, stats, fromNumbers, lastCall, busy, err, log, softphone,
    connect: () => run('connect', async () => {
      if (mode === 'browser') {
        const { token } = await post<{ token: string }>('/api/session/webrtc-token');
        await softphone.connect(token);
        await post('/api/session/connect', { mode: 'browser' });
      } else {
        await post('/api/session/connect', { mode: 'phone', phone });
      }
    }),
    disconnect: () => run('disconnect', async () => { await post('/api/session/disconnect'); softphone.disconnect(); }),
    startCalling: () => run('start calling', () => post('/api/session/burst')),
    manualDial: (to: string, from: string) => run('dial', () => post('/api/session/dial', { to, from })),
    hangupLead: () => run('hang up', () => post('/api/session/hangup-lead')),
    disposition: (outcome: Outcome, laterAt?: string) => run('disposition', async () => {
      if (!card) return;
      await post('/api/session/disposition', { callId: card.callId, outcome, laterAt: laterAt ? new Date(laterAt).toISOString() : undefined });
      setCard(null); setDuration(null); setPhase('idle'); setLegs([]); refreshStats(); note('disposition: ' + outcome);
    }),
    upload: (file: File) => run('import', async () => {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<ImportResult>('/api/leads/import', { method: 'POST', body: fd });
      note(`imported ${r.inserted} new, ${r.updated} updated, ${r.skipped.length} skipped, ${r.warnings.length} warnings`);
      for (const s of [...r.skipped, ...r.warnings].slice(0, 5) as { line: number; reason: string }[]) note(`  line ${s.line}: ${s.reason}`);
      refreshStats();
    }),
  };
}
