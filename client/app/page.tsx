'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Me } from '../lib/useDialer';
import Login from '../components/Login';
import CrmWorkspace from '../components/CrmWorkspace';
import Console from '../components/Console';
import Admin from '../components/admin/Admin';

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still checking
  const load = () => api<Me>('/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);

  if (me === undefined) return <main className="center"><p className="muted">Loading...</p></main>;
  if (!me) return <Login onDone={load} />;
  const onLogout = () => { api('/api/logout', { method: 'POST' }).finally(() => { if (me.storage === 'crm') window.location.reload(); else setMe(null); }); };
  if (me.storage === 'crm') return <CrmWorkspace me={me} onLogout={onLogout} />;
  if (me.role === 'admin') return <Admin me={me} onLogout={onLogout} />; // marketing@: dashboard only, no handset
  return <Console me={me} onLogout={onLogout} />;
}
