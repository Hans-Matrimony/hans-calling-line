import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q } from './db/pool.js';

export const COOKIE = 'eazybe_session';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error('SESSION_SECRET is not set');

const sign = (user) => jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '12h' });
export const verify = (token) => { try { return jwt.verify(token, SECRET); } catch { return null; } };

export function requireAuth(req, res, next) {
  const claims = verify(req.cookies?.[COOKIE]);
  if (!claims) return res.status(401).json({ error: 'not logged in' });
  req.userId = claims.uid;
  next();
}

/** Same check for the Socket.IO handshake, which has raw cookie headers, not cookie-parser. */
export function userIdFromCookieHeader(header) {
  const m = String(header ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? verify(decodeURIComponent(m.slice(COOKIE.length + 1)))?.uid ?? null : null;
}

export const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const { rows: [user] } = await q('SELECT * FROM users WHERE email = $1', [String(email ?? '').toLowerCase()]);
  if (!user || !(await bcrypt.compare(String(password ?? ''), user.password_hash))) {
    return res.status(401).json({ error: 'bad email or password' });
  }
  res.cookie(COOKIE, sign(user), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 * 1000,
  });
  res.json({ id: user.id, email: user.email, phone: user.phone });
});

router.post('/logout', (_req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

router.get('/me', requireAuth, async (req, res) => {
  const { rows: [u] } = await q(
    'SELECT id, email, phone, rep_leg_destination, telnyx_session_call_id FROM users WHERE id = $1', [req.userId]);
  if (!u) return res.status(401).json({ error: 'not logged in' }); // valid cookie, row deleted
  res.json(u);
});
