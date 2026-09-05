'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Me } from '../lib/useDialer';
import Login from '../components/Login';
import Console from '../components/Console';

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still checking
  const load = () => api<Me>('/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);

  if (me === undefined) return <main className="center"><p className="muted">Loading...</p></main>;
  if (!me) return <Login onDone={load} />;
  return <Console me={me} onLogout={() => { api('/api/logout', { method: 'POST' }).finally(() => setMe(null)); }} />;
}
