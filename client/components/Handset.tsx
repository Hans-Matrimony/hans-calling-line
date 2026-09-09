'use client';
import { useEffect, useRef, useState } from 'react';
import type { useDialer, FromNumber } from '../lib/useDialer';
import { DIAL_TIMEOUT, OUTCOME_LABEL, clock, prettyPhone, splitName } from '../lib/format';
import { Phone, Mic, MicOff, Keypad as KeypadIcon, Delete, ArrowRight } from './icons';

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

/* The Call/Hang-up button reuses one handset glyph, rotated 135deg by CSS on hang up — the way a
 * physical handset is lifted and dropped. All icons come from the shared ./icons set. */

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
  const digitsRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setIso(pref('eazybe.hs.cc', 'IN')); digitsRef.current?.focus(); }, []);
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
  useEffect(() => { if (d.prefill) { type(d.prefill); d.setPrefill(null); digitsRef.current?.focus(); } }, [d.prefill]); // eslint-disable-line react-hooks/exhaustive-deps

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
              <span>{regionOf(last.from) ? `from ${regionOf(last.from)!.iso} number at ${clock(last.at)}` : clock(last.at)}{last.outcome ? ` · ${OUTCOME_LABEL[last.outcome] ?? last.outcome}` : ' · dialed'}</span>
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
        <input ref={digitsRef} className="hs-digits" value={local} placeholder={iso ? 'Enter number' : 'Code and number'} inputMode="tel" autoComplete="off" spellCheck={false} aria-label="Number to call"
          onChange={(e) => type(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') dial(); }} />
        <button className="hs-bs" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setLocal((s) => s.slice(0, -1))} disabled={!local} aria-label="Delete last digit"><Delete /></button>
      </div>

      <div className="hs-keys">
        {KEYS.map(([k, sub]) => <button key={k} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setLocal((s) => s + k)} aria-label={k}><span>{k}</span><small>{sub}</small></button>)}
      </div>

      <div className="hs-action">
        <button className="hs-call" onClick={dial} disabled={!canDial} aria-label="Call"><Phone /></button>
        <p className="hs-hint">{why || (valid ? <>Call {prettyPhone(full)} <kbd>Enter</kbd></> : ' ')}</p>
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

/** In-call control rail (call-card v2): a slim horizontal bar under the lead stage. Mute, keypad and
 *  hang up while live; the ringing timer and give-up hint while ringing; a pointer to the card while
 *  the outcome is pending. Identity, timer and note all live on the card now, so nothing is repeated. */
function InCall({ d }: { d: D }) {
  const [pad, setPad] = useState(false);
  const [sent, setSent] = useState('');
  const [, tick] = useState(0);
  const [ringSince, setRingSince] = useState<Date | null>(null);
  useEffect(() => { setRingSince(d.phase === 'ringing' ? new Date() : null); }, [d.phase]);
  useEffect(() => { if (d.phase !== 'ringing') return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [d.phase]);

  const live = d.phase === 'live';
  const ringing = d.phase === 'ringing';
  const ended = d.phase === 'ended';
  const ringSecs = ringSince ? Math.max(0, Math.floor((Date.now() - ringSince.getTime()) / 1000)) : 0;
  const late = ringing && ringSecs >= DIAL_TIMEOUT - 5;
  const region = (() => { const r = d.fromNumbers.find((n) => n.number === d.legs[0]?.from)?.region; return d.legs.length === 1 && r ? REGION[r] : null; })();
  const press = (k: string) => { setSent((s) => (s + k).slice(-24)); d.sendDtmf(k); };

  return (
    <section className={'callbar ' + d.phase} aria-label="Call controls">
      {pad && live && (
        <div className="hs-dtmf">
          <div className="hs-keys dtmf">{KEYS.map(([k, sub]) => <button key={k} onClick={() => press(k)} aria-label={'Send ' + k}><span>{k}</span><small>{sub}</small></button>)}</div>
          <p className="hs-sent mono">{sent || 'Tones go to the other side — for menus and extensions.'}</p>
        </div>
      )}
      <div className="callbar-row">
        {ringing ? (
          <span className={'callbar-info' + (late ? ' late' : '')}><b>{d.legs.length > 1 ? 'Ringing both leads' : 'Ringing'}</b><span>{late ? `gives up at ${DIAL_TIMEOUT}s` : `${ringSecs}s`}</span></span>
        ) : ended ? (
          <span className="callbar-info">Save the outcome on the card <ArrowRight size={15} /></span>
        ) : (
          <>
            <button className={'ctool' + (d.softphone.muted ? ' on' : '')} onClick={d.softphone.toggleMute} disabled={!live} aria-pressed={d.softphone.muted}>{d.softphone.muted ? <MicOff /> : <Mic />}<span>{d.softphone.muted ? 'Unmute' : 'Mute'}</span></button>
            <button className={'ctool' + (pad ? ' on' : '')} onClick={() => setPad((v) => !v)} disabled={!live} aria-pressed={pad}><KeypadIcon /><span>Keypad</span></button>
            {region && <span className="callbar-src">Calling from your {region.name} number</span>}
          </>
        )}
        {!ended && (
          <button className={'hangbtn' + (ringing ? ' ringing' : '')} onClick={d.hangupLead} disabled={d.busy} aria-label={ringing ? 'Stop dialing' : 'Hang up'}>
            <Phone /><span>{ringing ? (d.legs.length > 1 ? 'Stop dialing both' : 'Stop dialing') : 'Hang up'}</span>
          </button>
        )}
      </div>
    </section>
  );
}
