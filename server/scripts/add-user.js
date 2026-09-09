// Plan s1: users are inserted by hand. Usage (from server/): node scripts/add-user.js email password [phone] [rep|admin]
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

const [email, password, phone, role = 'rep'] = process.argv.slice(2);
if (!email || !password) { console.error('usage: node scripts/add-user.js email password [phone] [rep|admin]'); process.exit(1); }
if (!['rep', 'admin'].includes(role)) { console.error('role must be rep or admin'); process.exit(1); }

await pool.query(
  `INSERT INTO users (email, password_hash, phone, rep_leg_destination, role) VALUES ($1, $2, $3, $3, $4)
   ON CONFLICT (email) DO UPDATE
     SET password_hash = EXCLUDED.password_hash, phone = COALESCE(EXCLUDED.phone, users.phone), role = EXCLUDED.role,
         active = true, deactivated_at = NULL`,
  [email.toLowerCase(), await bcrypt.hash(password, 10), phone || null, role]);
console.log('user ready:', email.toLowerCase());
await pool.end();
