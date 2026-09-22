// Run only during an approved cutover. Reads legacy PostgreSQL; writes only CRM calling admins.
import 'dotenv/config';
import pg from 'pg';
import { createStore } from '../src/crm/store.js';
if(!process.argv.includes('--apply'))throw new Error('Pass --apply to copy existing admin password hashes into the configured CRM database.');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL must identify the existing calling-line PostgreSQL database.');
const legacy=new pg.Client({connectionString:process.env.DATABASE_URL});
const store=createStore();
try {
  await legacy.connect();
  const {rows}=await legacy.query("SELECT id,email,password_hash,active FROM users WHERE role='admin'");
  for(const row of rows)await store.query(`INSERT INTO hans_calling_admins(id,email,password_hash,active) VALUES(?,?,?,?)
    ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),active=VALUES(active)`,[String(row.id),row.email,row.password_hash,row.active===false?0:1]);
  console.log(`${rows.length} existing admin logins copied. No rep accounts created.`);
} finally {await legacy.end();await store.close();}
