// Plan s1: users are inserted by hand. Usage (from server/):
//   node scripts/add-user.js <email> <password> [--phone=+9198...] [--admin]
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

// Flags, not positions: PowerShell silently drops a bare "" when calling a native command, which
// shifted 'admin' into the phone slot and left the role at 'rep'. --admin cannot be swallowed.
const argv = process.argv.slice(2);
const role = argv.includes('--admin') || argv.includes('--role=admin') ? 'admin' : 'rep';
const phoneFlag = argv.find((a) => a.startsWith('--phone='));
const [email, password, positionalPhone] = argv.filter((a) => !a.startsWith('--'));
const phone = phoneFlag ? phoneFlag.slice(8) : positionalPhone;
if (!email || !password) {
  console.error('usage: node scripts/add-user.js <email> <password> [--phone=+9198...] [--admin]');
  console.error('  PowerShell: quote the password in single quotes so @ and $ stay literal.');
  process.exit(1);
}
if (phone && !/^[+]?[0-9 ()-]{6,}$/.test(phone)) { console.error('that does not look like a phone number: ' + JSON.stringify(phone)); process.exit(1); }

await pool.query(
  `INSERT INTO users (email, password_hash, phone, rep_leg_destination, role) VALUES ($1, $2, $3, $3, $4)
   ON CONFLICT (email) DO UPDATE
     SET password_hash = EXCLUDED.password_hash, phone = COALESCE(EXCLUDED.phone, users.phone), role = EXCLUDED.role,
         active = true, deactivated_at = NULL`,
  [email.toLowerCase(), await bcrypt.hash(password, 10), phone || null, role]);
console.log('user ready:', email.toLowerCase(), '| role:', role, phone ? '| phone: ' + phone : '');
await pool.end();
