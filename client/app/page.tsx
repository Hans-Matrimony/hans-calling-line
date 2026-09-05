'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Me } from '../lib/useDialer';
import Login from '../components/Login';
import Dialer from '../components/Dialer';

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still checking
  const load = () => api<Me>('/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);

  if (me === undefined) return <main className="center"><p className="muted">Loading...</p></main>;
  if (!me) return <Login onDone={load} />;
  return <Dialer me={me} onLogout={() => { api('/api/logout', { method: 'POST' }).finally(() => setMe(null)); }} />;
}
