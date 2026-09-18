import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (see server/.env.example)');

// Managed hosts (Railway) force TLS on remote URLs; Coolify's internal Postgres has none —
// append ?sslmode=disable to DATABASE_URL there and it is honoured here.
export const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127[.]0[.]0[.]1|sslmode=disable|ssl=false/.test(url) ? false : { rejectUnauthorized: false },
});

const context = new AsyncLocalStorage();
export const q = (text, params) => (context.getStore()?.client ?? pool).query(text, params);

/** Related writes share one connection and either all commit or all roll back. */
export async function transaction(fn) {
  const current = context.getStore();
  if (current?.transaction) return fn();
  const client = current?.client ?? await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await context.run({ client, transaction: true }, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { if (!current?.client) client.release(); }
}

/** Session locks serialize external work across workers; a crash releases the lock automatically. */
const localLocks = new Set();
export async function withLock(key, fn) {
  if (localLocks.has(key)) return;
  localLocks.add(key);
  const current = context.getStore();
  let client;
  let locked = false;
  try {
    // Nested event/burst locks share a connection instead of exhausting the pool under load.
    client = current?.client ?? await pool.connect();
    const { rows: [r] } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key]);
    locked = r.locked;
    if (!locked) return;
    return await context.run({ client, transaction: current?.transaction ?? false }, fn);
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
    finally { if (!current?.client) client?.release(); localLocks.delete(key); }
  }
}
