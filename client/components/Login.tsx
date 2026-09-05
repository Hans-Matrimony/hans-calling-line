'use client';
import { useState, type FormEvent } from 'react';
import { post } from '../lib/api';

export default function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await post('/api/login', { email, password }); onDone(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <main className="center">
      <form className="login" onSubmit={submit}>
        <div className="brand"><span className="brand-name">Eazybe</span><span className="brand-sub">dialer</span></div>
        <label>Email<input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" /></label>
        <label>Password<input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        {err && <p className="err">{err}</p>}
        <button className="btn btn-blue btn-lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
