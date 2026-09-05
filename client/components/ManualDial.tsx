'use client';
import { useEffect, useState } from 'react';
import type { useDialer, FromNumber } from '../lib/useDialer';
import { prettyPhone } from '../lib/format';

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const REGION: Record<FromNumber['region'], string> = { india: 'IN', eu: 'UK', us: 'US' };

/** Type or tap a number, pick the caller ID, Call. Same burst/card/outcome flow as Start calling.
 *  Collapsible: the rep folds it away when the day is all queue work. */
export default function ManualDial({ d, open, onToggle }: { d: ReturnType<typeof useDialer>; open: boolean; onToggle: () => void }) {
  const [num, setNum] = useState('+');
  // A phone number is '+' and digits only. Typing/pasting anything else (letters, spaces) is stripped,
  // so the field can never hold "wasssup" and the Telnyx dial can never 422 on a bad number.
  const setDigits = (raw: string) => setNum('+' + raw.replace(/\D/g, ''));
  const [from, setFrom] = useState('');
  const inCall = d.phase !== 'idle';
  const valid = /^\+\d{7,15}$/.test(num);
  const canDial = d.rep === 'connected' && !inCall && !d.busy && valid && !!from;

  useEffect(() => { // default caller ID: first number still under its cap
    if (!from && d.fromNumbers.length) setFrom(d.fromNumbers.find((n) => n.available)?.number ?? d.fromNumbers[0].number);
  }, [d.fromNumbers, from]);

  const why = d.rep !== 'connected' ? 'Connect audio first.' : inCall ? 'Finish the current call first.' : !valid && num.length > 1 ? 'Use +country code, 7–15 digits.' : '';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Manual dial</h2>
        <button className="btn btn-ghost btn-mini" onClick={onToggle} aria-expanded={open} aria-controls="manual-dial">{open ? 'Minimize' : 'Open'}</button>
      </div>
      {open && (
        <div className="dial" id="manual-dial">
          <div className="num">
            <input className="field" value={num} inputMode="tel" autoComplete="off" spellCheck={false} aria-label="Number to call"
              onChange={(e) => setDigits(e.target.value)} onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === 'Enter' && canDial) d.manualDial(num, from); }} />
            <button className="btn" onClick={() => setDigits(num.slice(0, -1))} aria-label="Backspace" disabled={inCall}>⌫</button>
          </div>
          <div className="keys" aria-hidden={inCall}>
            {KEYS.map(([k, sub]) => <button key={k} onClick={() => setDigits(num + k)} disabled={inCall}><span>{k}</span><small>{sub}</small></button>)}
          </div>
          <div className="go">
            <select className="field" value={from} onChange={(e) => setFrom(e.target.value)} disabled={inCall} aria-label="Caller ID">
              {!d.fromNumbers.length && <option value="">No caller IDs configured</option>}
              {d.fromNumbers.map((n) => (
                <option key={n.number} value={n.number} disabled={!n.available}>
                  {REGION[n.region]} {prettyPhone(n.number)} · {n.usedToday}/{n.cap}{n.available ? '' : ' full'}
                </option>
              ))}
            </select>
            <button className="btn btn-green" onClick={() => d.manualDial(num, from)} disabled={!canDial}>Call</button>
          </div>
          {why && <p className="hint">{why}</p>}
        </div>
      )}
    </section>
  );
}
