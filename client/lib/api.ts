// Empty API base = same origin (production static export served by Express). Dev sets
// NEXT_PUBLIC_API_URL=http://localhost:3001 in .env.local.
export const API = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    credentials: 'include',
    headers: init.body instanceof FormData ? undefined : { 'content-type': 'application/json' },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.status + ' ' + res.statusText);
  return data;
}

export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
