import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool } from './pool.js';
import { resolveLead } from '../lib/countries.js';

const sql = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
await pool.query(sql);
const { rows } = await pool.query('SELECT id, country, coalesce(phones[1], phone) AS phone FROM leads WHERE timezone IS NULL');
for (const lead of rows) {
  const resolved = resolveLead(lead);
  if (resolved) await pool.query('UPDATE leads SET timezone = $2, utc_offset = $3 WHERE id = $1 AND timezone IS NULL', [lead.id, resolved.timezone, resolved.offset]);
}
console.log('schema applied');
await pool.end();
