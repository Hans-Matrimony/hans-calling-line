import { q, transaction } from '../db/pool.js';
import { activeBurst, repUp } from '../state.js';
import { leadCard, previewCard } from './burst.js';

export async function snapshot(userId) {
  const idle = { burstId: null, phase: 'idle', legs: [], card: null, answeredAt: null, duration: null };
  const { rows: [pending] } = await q(`SELECT b.id FROM bursts b
    WHERE b.user_id = $1 AND EXISTS (SELECT 1 FROM calls c WHERE c.burst_id = b.id AND c.disposition IS NULL)
    ORDER BY b.id DESC LIMIT 1`, [userId]);
  if (!pending) {
    if (activeBurst.get(userId) !== 0) activeBurst.delete(userId);
    return idle;
  }
  const burstId = pending.id;
  const { rows } = await q(`SELECT l.*, c.id AS "callId", c.lead_id AS "leadId",
    c.answered_at AS "answeredAt", c.duration, c.disposition, c.from_number AS "from",
    coalesce(c.to_number, l.phone) AS phone, b.winner_call_id AS "winnerId"
    FROM bursts b JOIN calls c ON c.burst_id = b.id JOIN leads l ON l.id = c.lead_id
    WHERE b.id = $1 ORDER BY c.id`, [burstId]);
  activeBurst.set(userId, burstId);
  const winner = rows.find((r) => r.callId === r.winnerId && !r.disposition);
  if (winner) return { burstId, phase: winner.duration == null ? 'live' : 'ended', legs: [],
    card: await leadCard(winner.callId), answeredAt: winner.answeredAt, duration: winner.duration };
  const open = rows.filter((r) => !r.disposition && !r.answeredAt);
  return { ...idle, burstId, phase: 'ringing', legs: open.map((r) => ({ leadId: r.leadId,
    name: r.name, phone: r.phone, country: r.country, from: r.from, status: 'ringing', card: previewCard(r) })) };
}

// The database protects recovery after a restart; the local token also covers a dial API request
// that has not returned a call id yet. Lock the rep row so simultaneous requests cannot both pass.
export async function reserveBurst(userId) {
  return transaction(async () => {
    const { rows: [u] } = await q('SELECT rep_connected FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!u?.rep_connected) return 'audioOff';
    repUp.add(userId);
    const { rows } = await q(`SELECT 1 FROM calls c JOIN bursts b ON b.id = c.burst_id
      WHERE b.user_id = $1 AND c.disposition IS NULL LIMIT 1`, [userId]);
    if (activeBurst.has(userId) || rows.length) return 'busy';
    // Share the user row lock with the idle worker: a newly reserved dial gets a fresh grace period.
    await q('UPDATE users SET audio_activity_at = now() WHERE id = $1', [userId]);
    activeBurst.set(userId, 0);
    return null;
  });
}
