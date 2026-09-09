'use client';
import { useState, type FormEvent } from 'react';
import { patch, post } from '../../lib/api';
import type { Me } from '../../lib/useDialer';
import { useAdmin, del, type AdminUser } from '../../lib/admin';
import { UserPlus, Trash, Refresh } from '../icons';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Add and remove reps. Remove = deactivate: login refused, live audio dropped, every lead and call
 *  kept for reporting. Their queued leads can be moved to another rep on the way out. */
export default function Users({ me, tick }: { me: Me; tick: number }) {
  const [bump, setBump] = useState(0);
  const users = useAdmin<AdminUser[]>('/api/admin/users', tick + bump);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState<'rep' | 'admin'>('rep');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null); const [moveTo, setMoveTo] = useState('');
  const refresh = () => setBump((b) => b + 1);
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); setMsg(what); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const add = (e: FormEvent) => { e.preventDefault(); run(`Added ${email.trim().toLowerCase()}.`, async () => { await post('/api/admin/users', { email, password, role }); setEmail(''); setPassword(''); setRole('rep'); }); };
  const remove = () => { if (!removing) return; const u = removing; run(`Removed ${u.email}.`, async () => { await del(`/api/admin/users/${u.id}`, moveTo ? { reassignTo: Number(moveTo) } : {}); setRemoving(null); setMoveTo(''); }); };
  const reactivate = (u: AdminUser) => run(`${u.email} is back.`, () => patch(`/api/admin/users/${u.id}`, { active: true }));
  const resetPw = (u: AdminUser) => { const pw = window.prompt(`New password for ${u.email} (8+ characters):`); if (pw) run(`Password reset for ${u.email}.`, () => patch(`/api/admin/users/${u.id}`, { password: pw })); };
  const active = (users.data ?? []).filter((u) => u.active), gone = (users.data ?? []).filter((u) => !u.active);
  const reps = active.filter((u) => u.role === 'rep' && u.id !== removing?.id);

  return (
    <section className="ad-screen">
      <div className="panel">
        <div className="panel-head"><h2 className="panel-title">Add a user</h2><span className="hint">a rep&apos;s email must be their HubSpot login email, or the HubSpot inlet cannot find their contacts</span></div>
        <form className="ad-form" onSubmit={add}>
          <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@eazybe.com" autoComplete="off" /></label>
          <label>Password<input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8+ characters" autoComplete="new-password" /></label>
          <label>Role<select value={role} onChange={(e) => setRole(e.target.value as 'rep' | 'admin')}><option value="rep">Rep — dials</option><option value="admin">Admin — this dashboard</option></select></label>
          <button className="btn btn-blue" disabled={busy}><UserPlus />Add</button>
        </form>
        {err && <p className="ad-err" style={{ margin: '10px 0 0' }}>{err}</p>}
        {msg && !err && <p className="hint" style={{ margin: '10px 0 0', color: 'var(--green-ink)' }}>{msg}</p>}
      </div>

      <div className="panel">
        <div className="panel-head"><h2 className="panel-title">Users<b>{active.length}</b></h2></div>
        {users.error && <p className="ad-err">{users.error}</p>}
        <div className="ad-scroll"><table className="ad-tbl">
          <thead><tr><th>Email</th><th>Role</th><th>HubSpot</th><th>Audio</th><th className="num">In queue</th><th className="num">Dials · 7 d</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id}>
                <td className="name">{u.email}{u.id === me.id && <span className="sub">you</span>}</td>
                <td><span className={'ad-pill ' + (u.role === 'admin' ? 'blue' : 'grey')}>{u.role}</span></td>
                <td>{u.role === 'rep' ? <span className={'ad-pill ' + (u.hubspot_mapped ? 'green' : 'amber')} title={u.hubspot_mapped ? 'matched to a HubSpot user by email' : 'no HubSpot user has this email'}>{u.hubspot_mapped ? 'matched' : 'not matched'}</span> : <span className="dim">—</span>}</td>
                <td>{u.role === 'rep' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><span className={'lamp ' + (u.audio ? 'green' : 'grey')} />{u.audio ? 'on' : 'off'}</span> : <span className="dim">—</span>}</td>
                <td className="num">{u.role === 'rep' ? u.in_queue : <span className="dim">—</span>}</td>
                <td className="num">{u.role === 'rep' ? u.dials_7d : <span className="dim">—</span>}</td>
                <td className="dim">{when(u.created_at)}</td>
                <td className="act" style={{ textAlign: 'right' }}>
                  <button className="btn btn-mini" onClick={() => resetPw(u)} disabled={busy}>Reset password</button>{' '}
                  {u.id !== me.id && <button className="btn btn-mini" onClick={() => { setRemoving(u); setMoveTo(''); }} disabled={busy}><Trash />Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {removing && (
          <div className="panel" style={{ marginTop: 12, borderColor: 'var(--coral-line)', background: 'var(--coral-dim)' }}>
            <p style={{ margin: 0 }}><b>Remove {removing.email}?</b> They cannot sign in any more and any call in progress ends. Every call they made stays in the reports.</p>
            {removing.role === 'rep' && removing.in_queue > 0 && (
              <p style={{ margin: '10px 0 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>They hold <b className="mono">{removing.in_queue}</b> queued lead{removing.in_queue === 1 ? '' : 's'}.</span>
                <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ font: 'inherit', padding: '5px 8px', borderRadius: 8, border: '1px solid var(--line-2)' }}>
                  <option value="">Leave them with the removed rep</option>
                  {reps.map((r) => <option key={r.id} value={r.id}>Move them to {r.email.split('@')[0]}</option>)}
                </select>
              </p>
            )}
            <p style={{ margin: '12px 0 0', display: 'flex', gap: 8 }}>
              <button className="btn btn-coral" onClick={remove} disabled={busy}><Trash />Remove {removing.email.split('@')[0]}</button>
              <button className="btn" onClick={() => setRemoving(null)} disabled={busy}>Keep</button>
            </p>
          </div>
        )}
      </div>

      {gone.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2 className="panel-title">Removed<b>{gone.length}</b></h2><span className="hint">history kept · reactivate to bring them back</span></div>
          <div className="ad-scroll"><table className="ad-tbl">
            <tbody>
              {gone.map((u) => (
                <tr key={u.id}><td className="dim">{u.email}</td><td className="dim">{u.role}</td><td className="dim">removed {when(u.deactivated_at)}</td>
                  <td className="act" style={{ textAlign: 'right' }}><button className="btn btn-mini" onClick={() => reactivate(u)} disabled={busy}><Refresh />Reactivate</button></td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </section>
  );
}
