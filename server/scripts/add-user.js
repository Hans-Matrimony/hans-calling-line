// Plan s1: users are inserted by hand. Usage (from server/): node scripts/add-user.js email password [phone]
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

const [email, password, phone] = process.argv.slice(2);
if (!email || !password) { console.error('usage: node scripts/add-user.js email password [phone]'); process.exit(1); }

await pool.query(
  `INSERT INTO users (email, password_hash, phone, rep_leg_destination) VALUES ($1, $2, $3, $3)
   ON CONFLICT (email) DO UPDATE
     SET password_hash = EXCLUDED.password_hash, phone = COALESCE(EXCLUDED.phone, users.phone)`,
  [email.toLowerCase(), await bcrypt.hash(password, 10), phone ?? null]);
console.log('user ready:', email.toLowerCase());
await pool.end();
