import { q } from '../db/pool.js';

// Admin toggles live in one small table (key -> JSONB). Defaults here are the truth when a row is
// missing, so a fresh database behaves the same as one where nothing was ever changed.
export const DEFAULTS = {
  hubspot_create_contacts: false,  // make a HubSpot contact for a dialed number that has none
};

export async function getSetting(key) {
  const { rows: [r] } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return r ? r.value : DEFAULTS[key];
}

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export function setSetting(key, value) {
  return q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
