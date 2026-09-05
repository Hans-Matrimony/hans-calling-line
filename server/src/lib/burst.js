import { q } from '../db/pool.js';
import { emitToUser } from '../io.js';
import { activeBurst } from '../state.js';
import { releaseLead, pickFromNumber } from './queue.js';
import { resolveLead } from './countries.js';
import { hangup, beep, bridge, dialLead, startTick, noAnswerTone, stopPlayback } from '../telnyx.js';

const BEEP_TIMEOUT_MS = 1500; // bridge anyway if Telnyx never reports the beep finished

// Rep-leg audio cues. The beep must finish before we bridge, so we wait for Telnyx's
// call.playback.ended for beep.wav on that leg (webhooks.js -> onRepPlaybackEnded).
const beepWaiters = new Map(); // rep call_control_id -> resolve()

export function onRepPlaybackEnded(repCcid, mediaUrl) {
  if (!/beep\.wav/.test(mediaUrl ?? '')) return;
  beepWaiters.get(repCcid)?.();
}

function beepThenWait(repCcid) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); beepWaiters.delete(repCcid); resolve(); };
    const t = setTimeout(done, BEEP_TIMEOUT_MS);
    beepWaiters.set(repCcid, done);
    beep(repCcid).catch((e) => { console.warn('beep failed', e.message); done(); });
  });
}

async function repLeg(userId) {
  const { rows: [u] } = await q('SELECT telnyx_session_call_id FROM users WHERE id = $1', [userId]);
  return u?.telnyx_session_call_id ?? null;
}

/** Silence the dialing tick (red hang-up button, rep leg lost, burst over). */
export async function stopRepAudio(userId) {
  const rep = await repLeg(userId);
  if (rep) await stopPlayback(rep);
}

/** Lead-leg webhook events. `state` is what we put in client_state when dialing. */
export async function onLeadEvent(type, p, { userId, burstId, leadId }) {
  if (type === 'call.answered') return onAnswered(p.call_control_id, userId, burstId, leadId);
  if (type === 'call.hangup') return onHangup(p, userId, burstId, leadId);
}

async function onAnswered(ccid, userId, burstId, leadId) {
  // The race (plan s11): the first answered leg claims the burst atomically. Everyone else lost.
  const { rows: [won] } = await q(
    `UPDATE bursts b SET winner_call_id = c.id FROM calls c
     WHERE b.id = $1 AND c.burst_id = b.id AND c.telnyx_call_id = $2 AND b.winner_call_id IS NULL
     RETURNING c.id AS call_id`, [burstId, ccid]);

  if (!won) {
    // Telnyx may redeliver call.answered for the leg that already won: ignore it, never hang it up.
    const { rows: [dup] } = await q(
      'SELECT 1 FROM bursts b JOIN calls c ON c.id = b.winner_call_id WHERE b.id = $1 AND c.telnyx_call_id = $2', [burstId, ccid]);
    if (dup) return;
    // A human picked up and we are hanging up on them: an abandoned call (plan s12, <2% target).
    await hangup(ccid);
    const { rowCount } = await q(
      `UPDATE calls SET disposition = 'abandoned', answered_at = now() WHERE telnyx_call_id = $1 AND disposition IS NULL`, [ccid]);
    if (rowCount) await releaseLead(leadId, 'no_answer'); // they were disturbed: counts as an attempt, retry in 2h
    return;
  }

  await q('UPDATE calls SET answered_at = now() WHERE id = $1', [won.call_id]);
  await cancelOpenLegs(burstId, won.call_id);
  emitToUser(userId, 'lead:answered', await leadCard(won.call_id)); // card is up while the beep sounds

  const rep = await repLeg(userId);
  if (!rep) { await hangup(ccid); return; } // rep leg vanished mid-burst

  try {
    await stopPlayback(rep);      // end the dialing tick
    await beepThenWait(rep);      // "say hello now"; resolves on playback.ended (or 1.5 s)
    await bridge(rep, ccid);
    emitToUser(userId, 'call:bridged', { callId: won.call_id });
  } catch (e) {
    console.error('bridge failed', e.message);
    await hangup(ccid);
    emitToUser(userId, 'call:error', { callId: won.call_id, error: 'bridge failed: ' + e.message });
  }
}

async function onHangup(p, userId, burstId, leadId) {
  const { rows: [c] } = await q('SELECT id, disposition, answered_at FROM calls WHERE telnyx_call_id = $1', [p.call_control_id]);
  if (!c) return;

  if (c.answered_at) {
    // Conversation over. Duration for the record; the disposition is the rep's call (no auto-advance).
    // Talk time = hangup minus answer (start_time in the payload is dial time). coalesce keeps a redelivery idempotent.
    const { rows: [d] } = await q(
      `UPDATE calls SET duration = coalesce(duration, EXTRACT(EPOCH FROM (now() - answered_at))::int) WHERE id = $1 RETURNING duration`, [c.id]);
    if (!c.disposition) emitToUser(userId, 'call:ended', { callId: c.id, leadId, duration: d.duration, cause: p.hangup_cause });
    return;
  }

  if (!c.disposition) {
    // Never answered. Timeout/busy/rejected -> no_answer. Dead numbers -> stop the lead.
    // The WHERE guard turns a redelivered hangup into a no-op instead of a double-counted attempt.
    const dead = /unallocated|invalid_number|number_changed|unassigned/.test(p.hangup_cause ?? '');
    const { rowCount } = await q('UPDATE calls SET disposition = $2 WHERE id = $1 AND disposition IS NULL', [c.id, dead ? 'failed' : 'no_answer']);
    if (rowCount) await releaseLead(leadId, dead ? 'invalid' : 'no_answer');
  }

  // Every leg settled and nobody won: the burst is over, the rep can click Start calling again.
  const { rows: [s] } = await q(
    `SELECT count(*) FILTER (WHERE disposition IS NULL)::int AS open,
            coalesce(bool_or(answered_at IS NOT NULL), false) AS answered
     FROM calls WHERE burst_id = $1`, [burstId]);
  if (s.open === 0 && !s.answered) {
    activeBurst.delete(userId);
    emitToUser(userId, 'burst:ended', { burstId, result: 'no_answer' });
    const rep = await repLeg(userId);
    if (rep) { await stopPlayback(rep); noAnswerTone(rep).catch((e) => console.warn('noanswer tone', e.message)); }
  }
}

/** Hang up every open leg in a burst except `keepCallId`. Unanswered losers go straight back
 *  to the queue: a cancelled ring is not an attempt. */
export async function cancelOpenLegs(burstId, keepCallId = null) {
  const { rows } = await q(
    `SELECT id, lead_id, telnyx_call_id, answered_at FROM calls
     WHERE burst_id = $1 AND disposition IS NULL AND ($2::int IS NULL OR id <> $2)`, [burstId, keepCallId]);
  for (const c of rows) {
    if (!c.answered_at) {
      await q(`UPDATE calls SET disposition = 'cancelled' WHERE id = $1`, [c.id]);
      await releaseLead(c.lead_id, 'cancelled');
    }
    if (c.telnyx_call_id) await hangup(c.telnyx_call_id);
  }
}

/** Lead card (plan s10): name, country, attempt #, last outcome. Company is not in the export. */
async function leadCard(callId) {
  const { rows: [r] } = await q(
    `SELECT c.id AS "callId", l.id AS "leadId", l.name, l.phone, l.country, l.segment, l.attempt_count + 1 AS attempt,
            (SELECT p.disposition FROM calls p WHERE p.lead_id = l.id AND p.id <> c.id AND p.disposition IS NOT NULL
             ORDER BY p.started_at DESC LIMIT 1) AS "lastOutcome"
     FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [callId]);
  return r;
}

/** Place one burst: a bursts row, one lead leg per lead (plan s8), `burst:started` to the rep.
 *  Shared by Start calling (2 queued leads, caller ID by region) and the manual dialer (1 typed
 *  number, caller ID chosen by the rep via `fromOverride`). Throws when no leg could be placed. */
export async function startBurst(userId, leads, fromOverride = null) {
  const { rows: [burst] } = await q('INSERT INTO bursts (user_id) VALUES ($1) RETURNING id', [userId]);
  activeBurst.set(userId, burst.id);
  const legs = [];
  for (const lead of leads) {
    const region = resolveLead({ country: lead.country, phone: lead.phone })?.region ?? 'us';
    const from = fromOverride ?? await pickFromNumber(region);
    if (!from) { await releaseLead(lead.id, 'cancelled'); continue; } // every number at its daily cap
    try {
      const ccid = await dialLead({ to: lead.phone, from, userId, burstId: burst.id, leadId: lead.id });
      await q('INSERT INTO calls (lead_id, burst_id, telnyx_call_id, from_number) VALUES ($1, $2, $3, $4)', [lead.id, burst.id, ccid, from]);
      legs.push({ leadId: lead.id, name: lead.name, phone: lead.phone, country: lead.country, from });
    } catch (e) {
      console.error('dial failed', lead.phone, e.message);
      await q(`INSERT INTO calls (lead_id, burst_id, from_number, disposition) VALUES ($1, $2, $3, 'failed')`, [lead.id, burst.id, from]);
      await releaseLead(lead.id, 'failed');
    }
  }
  if (!legs.length) { activeBurst.delete(userId); throw new Error('no legs could be placed'); }
  emitToUser(userId, 'burst:started', { burstId: burst.id, legs });
  const rep = await repLeg(userId);
  if (rep) startTick(rep).catch((e) => console.warn('tick failed', e.message)); // rep hears dialing in progress
  return { burstId: burst.id, legs };
}
