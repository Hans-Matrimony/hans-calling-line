'use client';
import { useEffect, useState } from 'react';
import type { useDialer, FromNumber } from '../lib/useDialer';
import { OUTCOME_LABEL, clock, mmss, prettyPhone, splitName } from '../lib/format';

type D = ReturnType<typeof useDialer>;

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

// [iso, dial code, name]. The team's lead mix first (plan s3), then the long tail. US before CA so a pasted +1 reads as US.
// The blank entry leaves just "+" on the chip: the rep types the country code as part of the number.
const CODES: [string, string, string][] = [
  ['', '', 'No country code — type it with the number'],
  ['IN', '91', 'India'], ['US', '1', 'United States'], ['GB', '44', 'United Kingdom'], ['AE', '971', 'United Arab Emirates'], ['SG', '65', 'Singapore'],
  ['CN', '86', 'China'], ['NG', '234', 'Nigeria'], ['AU', '61', 'Australia'], ['MY', '60', 'Malaysia'], ['CA', '1', 'Canada'],
  ['SA', '966', 'Saudi Arabia'], ['QA', '974', 'Qatar'], ['KW', '965', 'Kuwait'], ['OM', '968', 'Oman'], ['BH', '973', 'Bahrain'],
  ['DE', '49', 'Germany'], ['FR', '33', 'France'], ['NL', '31', 'Netherlands'], ['ES', '34', 'Spain'], ['IT', '39', 'Italy'], ['IE', '353', 'Ireland'],
  ['EG', '20', 'Egypt'], ['KE', '254', 'Kenya'], ['ZA', '27', 'South Africa'], ['PK', '92', 'Pakistan'], ['BD', '880', 'Bangladesh'], ['LK', '94', 'Sri Lanka'], ['NP', '977', 'Nepal'],
  ['PH', '63', 'Philippines'], ['ID', '62', 'Indonesia'], ['VN', '84', 'Vietnam'], ['TH', '66', 'Thailand'], ['JP', '81', 'Japan'], ['KR', '82', 'South Korea'], ['HK', '852', 'Hong Kong'],
  ['BR', '55', 'Brazil'], ['MX', '52', 'Mexico'], ['CO', '57', 'Colombia'], ['AR', '54', 'Argentina'], ['NZ', '64', 'New Zealand'], ['TR', '90', 'Turkey'], ['IL', '972', 'Israel'],
];
const BY_CODE_DESC = CODES.filter((c) => c[1]).sort((a, b) => b[1].length - a[1].length);

/** A real flag: Windows has no flag emoji (it draws the two letters instead), and the reps are on Windows.
 *  Falls back to the ISO code if the image cannot load (offline, blocked CDN). */
function Flag({ iso }: { iso: string }) {
  const [ok, setOk] = useState(true);
  return ok
    // eslint-disable-next-line @next/next/no-img-element -- a 20x15 PNG from a CDN; next/image needs a custom loader on a static export
    ? <img className="hs-flag" src={`https://flagcdn.com/w40/${iso.toLowerCase()}.png`} width={20} height={15} alt={iso} onError={() => setOk(false)} />
    : <span className="hs-flag txt" aria-label={iso}>{iso}</span>;
}
const REGION: Record<FromNumber['region'], { iso: string; name: string }> = {
  india: { iso: 'IN', name: 'India' }, eu: { iso: 'GB', name: 'United Kingdom' }, us: { iso: 'US', name: 'United States' },
};

const pref = (key: string, initial: string) => { try { return localStorage.getItem(key) ?? initial; } catch { return initial; } };
const savePref = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode etc. */ } };

/* Icons: one handset glyph does Call and Hang up (rotated 135deg by CSS), the way a physical handset is lifted and dropped. */
const Phone = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z" /></svg>;
const Mic = ({ off }: { off?: boolean }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{off && <path d="M4 4l16 16" />}</svg>;
const Grid = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>{[5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => <circle key={x + '-' + y} cx={x} cy={y} r="2" />))}</svg>;
const NoteIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h7" /></svg>;
const Backspace = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 5h11v14H9l-6-7z" /><path d="M12 9l5 5M17 9l-5 5" /></svg>;

/** The handset: a phone-shaped panel that is the rep's primary way to place a call by hand (PLAN-v2 s8, CallHippo
 *  parity). Keypad view while idle; in-call view (Mute / Dialpad / Note / Hang up) the moment anything is dialing,
 *  whether from this keypad or from Start calling. Lead facts and the outcome stay on the Stage card. */
export default function Handset({ d }: { d: D }) {
  return d.phase === 'idle' ? <Keypad d={d} /> : <InCall d={d} />;
}

function Keypad({ d }: { d: D }) {
  const [iso, setIso] = useState('IN');
  const [local, setLocal] = useState('');
  const [from, setFrom] = useState('');
  useEffect(() => { setIso(pref('eazybe.hs.cc', 'IN')); }, []);
  useEffect(() => { // remembered caller ID if still configured and under its cap, else the first that is
    if (!d.fromNumbers.length) return;
    const want = from || pref('eazybe.hs.from', '');
    const ok = d.fromNumbers.find((n) => n.number === want && n.available);
    const next = ok?.number ?? d.fromNumbers.find((n) => n.available)?.number ?? d.fromNumbers[0].number;
    if (next !== from) setFrom(next);
  }, [d.fromNumbers, from]);

  const code = CODES.find((c) => c[0] === iso)?.[1] ?? '91';
  const full = '+' + code + local;
  const valid = local.length >= (iso ? 4 : 7) && /^\+\d{7,15}$/.test(full);
  const ready = d.rep === 'connected' && !d.busy && !!from;
  const canDial = ready && valid;
  const regionOf = (num: string | null) => { const r = d.fromNumbers.find((n) => n.number === num)?.region; return r ? REGION[r] : null; };

  const chooseIso = (v: string) => { setIso(v); savePref('eazybe.hs.cc', v); };
  const chooseFrom = (v: string) => { setFrom(v); savePref('eazybe.hs.from', v); };
  const type = (raw: string) => {
    const s = raw.trim();
    if (iso && (s.startsWith('+') || s.startsWith('00'))) { // a pasted full number: split the dial code off into the picker
      const digits = s.replace(/\D/g, '').replace(/^00/, '');
      const hit = BY_CODE_DESC.find((c) => digits.startsWith(c[1]));
      if (hit) { chooseIso(hit[0]); setLocal(digits.slice(hit[1].length)); return; }
      chooseIso(''); setLocal(digits); return; // unknown code (e.g. +593): bare "+" chip, keep every digit - never prepend the old chip
    }
    setLocal(raw.replace(/\D/g, ''));
  };
  const dial = () => { if (canDial) d.manualDial(full, from); };
  // A number handed over from Up next / Activity (tap-to-dial): load it; the rep presses Call.
  useEffect(() => { if (d.prefill) { type(d.prefill); d.setPrefill(null); } }, [d.prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const why = d.rep !== 'connected' ? 'Connect audio to call.' : !from && d.fromNumbers.length ? 'Every caller ID has hit its daily cap.' : !d.fromNumbers.length ? 'No caller IDs configured.'
    : local && !valid ? (iso ? 'That number looks short.' : 'Start with the country code, e.g. 1 415 …') : '';
  const last = d.lastCall;
  const initials = (n: string | null) => (n ? n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : '');

  return (
    <section className="hs" aria-label="Dialer">
      <div className="hs-last">
        {last ? (
          <>
            <span className="hs-ava" aria-hidden>{initials(splitName(last.name).name) || <Phone />}</span>
            <button className="hs-lt" onClick={() => type(last.phone)} title="Load this number">
              <b>{splitName(last.name).name || prettyPhone(last.phone)}</b>
              <span>{regionOf(last.from) ? `via ${regionOf(last.from)!.iso} at ${clock(last.at)}` : clock(last.at)}{last.outcome ? ` · ${OUTCOME_LABEL[last.outcome] ?? last.outcome}` : ' · dialed'}</span>
            </button>
            <button className="hs-redial" onClick={() => d.manualDial(last.phone, from)} disabled={!ready} aria-label="Call again"><Phone /></button>
          </>
        ) : (
          <span className="hs-lt"><span>Last call</span><b className="muted">No calls yet today</b></span>
        )}
      </div>

      <div className="hs-num">
        <span className="hs-cc">
          <b>{iso && <Flag iso={iso} />} +{code}</b>
          <select value={iso} onChange={(e) => chooseIso(e.target.value)} aria-label="Country code">
            {CODES.map(([i, c, n]) => <option key={i || 'none'} value={i}>{i ? `${n} +${c}` : n}</option>)}
          </select>
        </span>
        <input className="hs-digits" value={local} placeholder={iso ? 'Enter number' : 'Code and number'} inputMode="tel" autoComplete="off" spellCheck={false} aria-label="Number to call"
          onChange={(e) => type(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') dial(); }} />
        <button className="hs-bs" onClick={() => setLocal((s) => s.slice(0, -1))} disabled={!local} aria-label="Delete last digit"><Backspace /></button>
      </div>

      <div className="hs-keys">
        {KEYS.map(([k, sub]) => <button key={k} onClick={() => setLocal((s) => s + k)} aria-label={k}><span>{k}</span><small>{sub}</small></button>)}
      </div>

      <div className="hs-action">
        <button className="hs-call" onClick={dial} disabled={!canDial} aria-label="Call"><Phone /></button>
        <p className="hs-hint">{why || (valid ? `Call ${prettyPhone(full)}` : ' ')}</p>
      </div>

      <label className="hs-from">
        <span className="fl" aria-hidden>{regionOf(from) ? <Flag iso={regionOf(from)!.iso} /> : <Phone />}</span>
        <select value={from} onChange={(e) => chooseFrom(e.target.value)} aria-label="Caller ID">
          {!d.fromNumbers.length && <option value="">No caller IDs configured</option>}
          {d.fromNumbers.map((n) => (
            <option key={n.number} value={n.number} disabled={!n.available}>
              {REGION[n.region].name} · {prettyPhone(n.number)} · {n.usedToday}/{n.cap}{n.available ? '' : ' full'}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function InCall({ d }: { d: D }) {
  const [pad, setPad] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [sent, setSent] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!d.answeredAt || d.phase !== 'live') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [d.answeredAt, d.phase]);

  const live = d.phase === 'live';
  const ringing = d.phase === 'ringing';
  const secs = d.phase === 'ended' ? d.duration ?? 0 : d.answeredAt ? Math.max(0, Math.floor((Date.now() - d.answeredAt.getTime()) / 1000)) : 0;
  const c = d.card;
  const leg0 = d.legs[0];
  const phone = c?.phone ?? leg0?.phone ?? '';
  const name = splitName(c?.name ?? (d.legs.length === 1 ? leg0?.name ?? null : null)).name;
  const region = (() => { const r = d.fromNumbers.find((n) => n.number === leg0?.from)?.region; return r ? REGION[r] : null; })();
  const many = ringing && d.legs.length > 1;

  const eyebrow = ringing ? `Outgoing via ${region?.name ?? 'Eazybe'}` : live ? 'On the line' : 'Call ended';
  const title = many ? `Ringing ${d.legs.length} leads` : name || prettyPhone(phone) || '—';
  const sub = many ? d.legs.map((l) => l.name || prettyPhone(l.phone)).join('  ·  ') : name ? prettyPhone(phone) : null;
  const press = (k: string) => { setSent((s) => (s + k).slice(-24)); d.sendDtmf(k); };

  return (
    <section className={'hs ' + d.phase} aria-label="Call in progress" aria-live="polite">
      <div className="hs-status">
        <span className="hs-eyebrow">{eyebrow}</span>
        <div className="hs-who">{title}</div>
        {sub && <div className="hs-sub mono">{sub}</div>}
        <div className="hs-timer">{ringing ? 'Ringing…' : mmss(secs)}</div>
      </div>

      {pad && live && (
        <div className="hs-dtmf">
          <div className="hs-keys dtmf">{KEYS.map(([k, sub]) => <button key={k} onClick={() => press(k)} aria-label={'Send ' + k}><span>{k}</span><small>{sub}</small></button>)}</div>
          <p className="hs-sent mono">{sent || 'Tones go to the other side — for menus and extensions.'}</p>
        </div>
      )}

      {noteOpen && (
        <textarea className="field" rows={3} value={d.note} onChange={(e) => d.setNote(e.target.value)} autoFocus
          placeholder="Note — saved with the outcome, shown next time this lead comes up" aria-label="Call note" />
      )}

      <div className="hs-tiles">
        <button className={d.softphone.muted ? 'on' : ''} onClick={d.softphone.toggleMute} disabled={!live} aria-pressed={d.softphone.muted}><Mic off={d.softphone.muted} /><span>{d.softphone.muted ? 'Unmute' : 'Mute'}</span></button>
        <button className={pad ? 'on' : ''} onClick={() => setPad((v) => !v)} disabled={!live} aria-pressed={pad}><Grid /><span>Dialpad</span></button>
        <button className={noteOpen || d.note ? 'on' : ''} onClick={() => setNoteOpen((v) => !v)} aria-pressed={noteOpen}><NoteIcon /><span>Note</span></button>
      </div>

      <div className="hs-action">
        {d.phase === 'ended'
          ? <p className="hs-hint">Save an outcome on the call card.</p>
          : <button className={'hs-call hang' + (ringing ? ' ringing' : '')} onClick={d.hangupLead} disabled={d.busy} aria-label={ringing ? 'Stop dialing' : 'Hang up'}><Phone /></button>}
      </div>
    </section>
  );
}
