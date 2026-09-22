import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';

export function createStore(env = process.env) {
  for (const key of ['CRM_DB_HOST', 'CRM_DB_NAME', 'CRM_DB_USER']) {
    if (!env[key]) throw new Error(`${key} is required in crm_mysql mode`);
  }
  const pool = mysql.createPool({ host: env.CRM_DB_HOST, port: Number(env.CRM_DB_PORT || 3306),
    database: env.CRM_DB_NAME, user: env.CRM_DB_USER, password: env.CRM_DB_PASSWORD || '',
    connectionLimit: 10, timezone: 'Z', dateStrings: true, multipleStatements: false,
    ...(env.CRM_DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) });
  const query = async (sql, values = []) => (await pool.execute(sql, values))[0];
  // Connection-scoped locks serialize operations across processes without modifying CRM users.
  const locked = async (key, fn) => {
    const connection = await pool.getConnection();
    const q = async (sql, values = []) => (await connection.execute(sql, values))[0];
    try {
      const [row] = await q('SELECT GET_LOCK(?, 5) AS acquired', [`hans_calling:${key}`]);
      if (Number(row.acquired) !== 1) throw Object.assign(new Error('Calling operation in progress. Retry shortly.'), { status: 409 });
      try { return await fn(q); }
      finally { await q('SELECT RELEASE_LOCK(?)', [`hans_calling:${key}`]); }
    } finally { connection.release(); }
  };
  return { query, locked, close: () => pool.end(), migrate: async () => {
    const sql = await readFile(new URL('../../sql/crm-mysql.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await query(statement);
  } };
}
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const one = async (q, sql, args = []) => (await q(sql, args))[0] || null;
export const normalizePhone = value => {
  const raw = String(value || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  else if (!raw.startsWith('+') && digits.length === 10) digits = '91' + digits;
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw fail(422, 'Lead has no valid phone number.');
  return '+' + digits;
};
// CRM DATETIME columns use Asia/Kolkata wall time; calling tables use UTC.
export const crmToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const eligibleSql = `SELECT r.id AS requestId, r.lead_id AS leadId, r.lead_type AS leadType,
  CASE WHEN r.lead_type IN (0,3) THEN u.name ELSE i.full_name END AS name,
  CASE WHEN r.lead_type IN (0,3) THEN u.user_mobile ELSE i.user_phone END AS phone
  FROM user_request_leads r
  LEFT JOIN leads l ON r.lead_type IN (0,3) AND l.id=r.lead_id
  LEFT JOIN user_data u ON u.id=l.user_data_id
  LEFT JOIN incomplete_leads i ON r.lead_type IN (1,2,4,5,6,7,8,9) AND i.id=r.lead_id
  WHERE r.user_id=? AND r.lead_status='requested' AND r.lead_type IN (0,1,2,3,4,5,6,7,8,9)
    AND (CASE WHEN r.lead_type IN (0,3) THEN l.created_at ELSE COALESCE(i.meta_date,i.created_at) END) < DATE_SUB(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE), INTERVAL 24 HOUR)
    AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)`;
export async function eligibleLeads(q, userId, requestId) {
  const today = crmToday();
  const args = [userId, today, today];
  if (requestId) args.push(requestId);
  return q(eligibleSql + (requestId ? ' AND r.id=?' : '') + ' ORDER BY r.id DESC', args);
}
