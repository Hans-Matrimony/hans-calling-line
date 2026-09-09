import { q } from '../db/pool.js';
import { emitToUser, pokeAdmins } from '../io.js';
import { startLeadRecording } from './recordings.js';
import { logCall } from './hubspotCalls.js';
import { activeBurst } from '../state.js';
import { releaseLead, pickFromNumber } from './queue.js';
import { resolveLead } from './countries.js';
import { hangup, beep, bridge, dialLead, startTick, noAnswerTone, stopPlayback } from '../telnyx.js';

const BEEP_TIMEOUT_MS = 900; // bridge anyway if Telnyx never reports the beep finished; short, to shrink the dead-air window in which a lead can hang up before we bridge

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
     WHERE b.id = $1 AND c.burst_id = b.id AND c.telnyx_call_id = $2 AND b.winner_call_id IS NULL AND c.disposition IS NULL
     RETURNING c.id AS call_id`, [burstId, ccid]);

  if (!won) {
    // Telnyx may redeliver call.answered for the leg that already won: ignore it, never hang it up.
    const { rows: [dup] } = await q(
      'SELECT 1 FROM bursts b JOIN calls c ON c.id = b.winner_call_id WHERE b.id = $1 AND c.telnyx_call_id = $2', [burstId, ccid]);
    if (dup) return;
    // A human picked up after another lead already won and we hang up on them: an abandoned call (plan s12, <2% target).
    // A leg that answers after the rep pressed the red button (no winner) stays 'cancelled': no attempt, back in 10 min.
    await hangup(ccid);
    const { rows: [ab] } = await q(
      `UPDATE calls c SET disposition = 'abandoned', answered_at = now() FROM bursts b
       WHERE c.telnyx_call_id = $1 AND b.id = c.burst_id AND b.winner_call_id IS NOT NULL
         AND (c.disposition IS NULL OR c.disposition = 'cancelled') RETURNING c.id, c.lead_id`, [ccid]);
    if (ab) {
      // Read the number before releasing: this attempt can roll the lead onto its next number,
      // and the toast must name the line we actually disturbed.
      const { rows: [l] } = await q('SELECT name, phone FROM leads WHERE id = $1', [ab.lead_id]);
      await releaseLead(ab.lead_id, 'no_answer'); // they were disturbed: counts as an attempt, retry in 2h
      emitToUser(userId, 'lead:abandoned', { leadId: ab.lead_id, name: l?.name ?? null, phone: l?.phone ?? null });
      logCall(ab.id).catch((e) => console.warn('hubspot logCall', e.message));
    }
    return;
  }

  await q('UPDATE calls SET answered_at = now() WHERE id = $1', [won.call_id]);
  await cancelOpenLegs(burstId, won.call_id);
  // Card goes up while the beep sounds. Not awaited: a DB hiccup here must never leave an answered human unbridged.
  leadCard(won.call_id).then((card) => emitToUser(userId, 'lead:answered', card)).catch((e) => console.error('leadCard', e.message));

  const rep = await repLeg(userId);
  if (!rep) { await hangup(ccid); return; } // rep leg vanished mid-burst

  try {
    await stopPlayback(rep);      // end the dialing tick
    await beepThenWait(rep);      // "say hello now"; resolves on playback.ended (or the timeout)
    await bridge(rep, ccid);
    // Record from here: only a bridged conversation, only the lead leg (the rep's leg lives all shift).
    // Not awaited and never throws - recording must not touch the call.
    startLeadRecording(won.call_id, ccid, { kind: 'lead', userId, burstId, leadId });
    emitToUser(userId, 'call:bridged', { callId: won.call_id });
    pokeAdmins('live');
  } catch (e) {
    // Most common: the lead hung up during the beep window, so bridge hits a dead leg (90015/90018).
    // Never strand the rep in a fake call - silence the rep leg and end this call so the UI leaves 'live'
    // and the rep can disposition it (the lead's own call.hangup, if any, settles the rest idempotently).
    console.warn('bridge failed', e.message);
    await stopRepAudio(userId);
    await hangup(ccid).catch(() => {}); // drop the lead if still up; ignore "already ended"
    const { rows: [d] } = await q(
      `UPDATE calls SET duration = coalesce(duration, EXTRACT(EPOCH FROM (now() - answered_at))::int) WHERE id = $1 RETURNING duration, disposition`, [won.call_id]);
    if (!d?.disposition) emitToUser(userId, 'call:ended', { callId: won.call_id, leadId, duration: d?.duration ?? 0, cause: 'bridge_failed' });
  }
}

async function onHangup(p, userId, burstId, leadId) {
  const { rows: [c] } = await q('SELECT id, disposition, answered_at FROM calls WHERE telnyx_call_id = $1', [p.call_control_id]);
  if (!c) return;
  await q('UPDATE calls SET ended_at = coalesce(ended_at, now()) WHERE id = $1', [c.id]); // ring time for the log; talk time is still duration

  if (c.answered_at) {
    // Conversation over. Duration for the record; the disposition is the rep's call (no auto-advance).
    // Talk time = hangup minus answer (start_time in the payload is dial time). coalesce keeps a redelivery idempotent.
    const { rows: [d] } = await q(
      `UPDATE calls SET duration = coalesce(duration, EXTRACT(EPOCH FROM (now() - answered_at))::int) WHERE id = $1 RETURNING duration`, [c.id]);
    if (!c.disposition) emitToUser(userId, 'call:ended', { callId: c.id, leadId, duration: d.duration, cause: p.hangup_cause });
    pokeAdmins('live');
    return;
  }

  if (!c.disposition) {
    // Never answered. Timeout/busy/rejected -> no_answer. Dead numbers -> stop the lead.
    // The WHERE guard turns a redelivered hangup into a no-op instead of a double-counted attempt.
    const dead = /unallocated|invalid_number|number_changed|unassigned/.test(p.hangup_cause ?? '');
    const { rowCount } = await q('UPDATE calls SET disposition = $2 WHERE id = $1 AND disposition IS NULL', [c.id, dead ? 'failed' : 'no_answer']);
    if (rowCount) {
      await releaseLead(leadId, dead ? 'invalid' : 'no_answer');
      logCall(c.id).catch((e) => console.warn('hubspot logCall', e.message)); // nobody answered: no outcome step will follow
    }
  }

  // Every leg settled and nobody won: the burst is over, the rep can click Start calling again.
  const { rows: [s] } = await q(
    `SELECT count(*) FILTER (WHERE disposition IS NULL)::int AS open,
            coalesce(bool_or(answered_at IS NOT NULL), false) AS answered
     FROM calls WHERE burst_id = $1`, [burstId]);
  if (s.open === 0 && !s.answered) {
    activeBurst.delete(userId);
    emitToUser(userId, 'burst:ended', { burstId, result: 'no_answer', legs: await burstLegs(burstId) });
    pokeAdmins('live');
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
      // Guard, not just the SELECT above: the three callers race (a lead answered, the red button,
      // the rep leg dropping), and only one of them may release the lead.
      const { rowCount } = await q(`UPDATE calls SET disposition = 'cancelled' WHERE id = $1 AND disposition IS NULL`, [c.id]);
      if (rowCount) await releaseLead(c.lead_id, 'cancelled');
    }
    if (c.telnyx_call_id) await hangup(c.telnyx_call_id);
  }
}

/** Every leg of a burst with how it ended, for burst:ended (one named tape tile per lead, not one per burst). */
export async function burstLegs(burstId) {
  const { rows } = await q(
    // to_number, not l.phone: this runs after every leg was released, and a released lead may have
    // already rolled onto its next number. The tape must name what rang.
    `SELECT l.id AS "leadId", l.name, coalesce(c.to_number, l.phone) AS phone, c.disposition
     FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.burst_id = $1 ORDER BY c.id`, [burstId]);
  return rows;
}

/** A lead card built straight from a claimed lead row, for the ringing preview (call-card v2): the
 *  rep reads who they're calling while it rings, not only once they say hello. No call row is needed,
 *  so callId is 0 and lastOutcome/lastNote are left to the live card (leadCard) once one leg wins. */
export function previewCard(lead) {
  return {
    callId: 0, leadId: lead.id, name: lead.name, phone: lead.phone, country: lead.country, segment: lead.segment,
    utcOffset: lead.utc_offset, hubspotId: lead.hubspot_contact_id, extra: lead.extra ?? {},
    attempt: (lead.attempt_count ?? 0) + 1, lastOutcome: null, lastNote: null,
    lastCallAt: lead.last_call_at ?? null, everConnected: null, callCount: lead.attempt_count ?? 0,
    phones: lead.phones ?? [lead.phone], phoneIdx: lead.phone_idx ?? 1,
  };
}

/** Lead card (plan s10): name, country, attempt #, last outcome. Company is not in the export. */
export async function leadCard(callId) {
  const { rows: [r] } = await q(
    `SELECT c.id AS "callId", l.id AS "leadId", l.name, coalesce(c.to_number, l.phone) AS phone, l.country, l.segment,
            l.utc_offset AS "utcOffset", l.phones, l.phone_idx AS "phoneIdx",
            l.hubspot_contact_id AS "hubspotId", l.extra, l.attempt_count + 1 AS attempt, l.attempt_count AS "callCount",
            (SELECT p.disposition FROM calls p WHERE p.lead_id = l.id AND p.id <> c.id AND p.disposition IS NOT NULL
             ORDER BY p.started_at DESC LIMIT 1) AS "lastOutcome",
            (SELECT p.notes FROM calls p WHERE p.lead_id = l.id AND p.id <> c.id AND p.notes IS NOT NULL
             ORDER BY p.started_at DESC LIMIT 1) AS "lastNote",
            -- History summary for the card (call-card v2): when we last reached out, and whether this lead
            -- has ever actually connected - the two facts a rep wants before the pitch.
            (SELECT p.started_at FROM calls p WHERE p.lead_id = l.id AND p.id <> c.id AND p.disposition IS DISTINCT FROM 'cancelled'
             ORDER BY p.started_at DESC LIMIT 1) AS "lastCallAt",
            EXISTS (SELECT 1 FROM calls p WHERE p.lead_id = l.id AND p.id <> c.id AND p.disposition = 'connected') AS "everConnected"
     FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [callId]);
  return r;
}

/** Place one burst: a bursts row, one lead leg per lead (plan s8), `burst:started` to the rep.
 *  Shared by Start calling (2 queued leads, caller ID by region) and the manual dialer (1 typed
 *  number, caller ID chosen by the rep via `fromOverride`). Throws when no leg could be placed. */
export async function startBurst(userId, leads, fromOverride = null, extra = {}) {
  const { rows: [burst] } = await q('INSERT INTO bursts (user_id) VALUES ($1) RETURNING id', [userId]);
  activeBurst.set(userId, burst.id);
  const legs = [];
  for (const lead of leads) {
    // Caller ID follows the lead's Country column, as it always has - except on an alternate, where
    // the number's own dial code wins: a +44 alternate on an India-country lead answers far better
    // from the EU caller ID than the Indian one. The lead's timezone never moves with it.
    const onAlternate = (lead.phone_idx ?? 1) > 1;
    const byNumber = onAlternate ? resolveLead({ country: null, phone: lead.phone }) : null;
    const region = byNumber?.region ?? resolveLead({ country: lead.country, phone: lead.phone })?.region ?? 'us';
    const from = fromOverride ?? await pickFromNumber(region);
    if (!from) { await q(`UPDATE leads SET status = 'queued' WHERE id = $1`, [lead.id]); continue; } // every number at its cap: nothing rang, so no cooldown
    try {
      const ccid = await dialLead({ to: lead.phone, from, userId, burstId: burst.id, leadId: lead.id });
      await q('INSERT INTO calls (lead_id, burst_id, telnyx_call_id, from_number, to_number) VALUES ($1, $2, $3, $4, $5)', [lead.id, burst.id, ccid, from, lead.phone]);
      legs.push({ leadId: lead.id, name: lead.name, phone: lead.phone, country: lead.country, from, card: previewCard(lead) });
    } catch (e) {
      console.error('dial failed', lead.phone, e.message);
      await q(`INSERT INTO calls (lead_id, burst_id, from_number, to_number, disposition) VALUES ($1, $2, $3, $4, 'failed')`, [lead.id, burst.id, from, lead.phone]);
      await releaseLead(lead.id, 'cancelled'); // the phone never rang: back in 10 min, no attempt consumed
      emitToUser(userId, 'lead:failed', { leadId: lead.id, name: lead.name, phone: lead.phone, error: e.message });
    }
  }
  if (!legs.length) { activeBurst.delete(userId); throw new Error('no legs could be placed'); }
  emitToUser(userId, 'burst:started', { burstId: burst.id, legs, manual: !!fromOverride, ...extra });
  pokeAdmins('live');
  const rep = await repLeg(userId);
  if (rep) startTick(rep).catch((e) => console.warn('tick failed', e.message)); // rep hears dialing in progress
  return { burstId: burst.id, legs };
}
