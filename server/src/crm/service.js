import { randomUUID, randomBytes } from 'node:crypto';
import { need, publicUrl, plivoRequest } from '../plivoTransport.js';
import { eligibleLeads, fail, normalizePhone, one } from './store.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const table = kind => kind === 'audio' ? 'hans_calling_sessions' : 'hans_calling_calls';
const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
const emptyXml = '<Response><Hangup/></Response>';
export function createCallingService(store, provider = plivoRequest) {
  const q = store.query;
  const callback = (event, kind, id) => publicUrl() + '/webhooks/crm/' + event + '?' + new URLSearchParams({ kind, id });
  const get = (kind, id) => one(q, `SELECT * FROM ${table(kind)} WHERE id=?`, [id]);
  async function stopLeg(kind, id) {
    await q(`UPDATE ${table(kind)} SET stop_requested=1 WHERE id=? AND ended_at IS NULL`, [id]);
    const row = await get(kind, id);
    if (!row || row.ended_at) return;
    const path = row.call_uuid ? `Call/${encodeURIComponent(row.call_uuid)}/` : row.request_uuid ? `Request/${encodeURIComponent(row.request_uuid)}/` : null;
    if (!path) return; // An uncertain dial remains reserved until a callback/reconciliation resolves it.
    try { await provider(path, 'DELETE'); }
    catch (e) { if (![404,410].includes(e.status)) throw e; }
    // A successful DELETE acknowledges cancellation; preserve later provider hangup/CDR detail.
    await q(`UPDATE ${table(kind)} SET status='ended', ended_at=COALESCE(ended_at,UTC_TIMESTAMP(3)) WHERE id=?`, [id]);
  }
  async function stopSession(id) {
    await q('UPDATE hans_calling_sessions SET stop_requested=1 WHERE id=?', [id]);
    const calls = await q('SELECT id FROM hans_calling_calls WHERE session_id=? AND ended_at IS NULL', [id]);
    const results = await Promise.allSettled(calls.map(c => stopLeg('call', c.id)));
    await stopLeg('audio', id);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function dial(kind, row, to) {
    const reserved = await get(kind, row.id);
    if (reserved.stop_requested || reserved.ended_at) {
      await q(`UPDATE ${table(kind)} SET status='ended',ended_at=COALESCE(ended_at,UTC_TIMESTAMP(3)) WHERE id=?`, [row.id]);
      return get(kind,row.id);
    }
    try {
      const result = await provider('Call/', 'POST', {
        to, from: row.from_number || need('FROM_NUMBER_INDIA'),
        answer_url: callback('answer', kind, row.id), answer_method: 'POST',
        ring_url: callback('ring', kind, row.id), ring_method: 'POST',
        hangup_url: callback('hangup', kind, row.id), hangup_method: 'POST',
        fallback_url: callback('fallback', kind, row.id), fallback_method: 'POST',
        ring_timeout: kind === 'audio' ? 40 : 30, time_limit: 14400,
      });
      if (typeof result.request_uuid !== 'string') throw new Error('Missing provider request identifier');
      await q(`UPDATE ${table(kind)} SET request_uuid=? WHERE id=?`, [result.request_uuid, row.id]);
      if ((await get(kind, row.id)).stop_requested) await stopLeg(kind, row.id);
    } catch (e) {
      const definite = e.status >= 400 && e.status < 500 && ![408,429].includes(e.status);
      await q(`UPDATE ${table(kind)} SET stop_requested=1, status=?,
        ended_at=IF(?,COALESCE(ended_at,UTC_TIMESTAMP(3)),ended_at), hangup_cause=? WHERE id=?`,
      [definite ? 'failed' : 'uncertain', definite ? 1 : 0, definite ? 'provider_rejected' : 'provider_response_uncertain', row.id]);
      throw fail(502, definite ? 'Calling provider rejected the call.' : 'Provider response is uncertain. The reserved call is being stopped; do not redial yet.');
    }
    return get(kind, row.id);
  }
  async function credentials(userId, owner) {
    if (!uuid(owner)) throw fail(422, 'Invalid browser session.');
    return store.locked('user:' + userId, async query => {
      const active = await one(query, 'SELECT owner_token FROM hans_calling_sessions WHERE crm_user_id=? AND ended_at IS NULL LIMIT 1', [userId]);
      if (active && active.owner_token !== owner) throw fail(409, 'Audio is active in another window.');
      let agent = await one(query, 'SELECT * FROM hans_calling_agents WHERE crm_user_id=?', [userId]);
      if (!agent?.sip_username) {
        const endpoint = await provider('Endpoint/', 'POST', {
          username: 'hanscrm' + userId + randomBytes(4).toString('hex'), password: randomBytes(24).toString('base64url'),
          alias: 'crm-tse-' + userId, app_id: need('PLIVO_APPLICATION_ID'),
        });
        if (!endpoint.username || !endpoint.endpoint_id) throw fail(502, 'Could not provision browser audio.');
        await query(`INSERT INTO hans_calling_agents(crm_user_id,endpoint_id,sip_username) VALUES(?,?,?)
          ON DUPLICATE KEY UPDATE endpoint_id=VALUES(endpoint_id),sip_username=VALUES(sip_username)`, [userId,endpoint.endpoint_id,endpoint.username]);
        agent = { sip_username: endpoint.username };
      }
      const now = Math.floor(Date.now()/1000);
      const response = await provider('JWT/Token/', 'POST', { iss: need('PLIVO_AUTH_ID'), sub: agent.sip_username,
        nbf: now-30, exp: now+3600, per: { voice: { incoming_allow: true, outgoing_allow: false } }, app: need('PLIVO_APPLICATION_ID') });
      if (!response.token) throw fail(502, 'Could not authenticate browser audio.');
      return { token: response.token };
    });
  }
  function configured() {
    need('PLIVO_AUTH_ID'); need('PLIVO_AUTH_TOKEN'); need('FROM_NUMBER_INDIA');
    if (!publicUrl().startsWith('https://')) throw fail(503, 'Calling requires a public HTTPS callback URL.');
  }
  async function startAudio(userId, owner) {
    if (!uuid(owner)) throw fail(422, 'Invalid browser session.');
    configured();
    const { row, fresh, username } = await store.locked('user:' + userId, async query => {
      const active = await one(query, 'SELECT * FROM hans_calling_sessions WHERE crm_user_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', [userId]);
      if (active) {
        if (active.owner_token !== owner || active.stop_requested) throw fail(409, 'Audio is already active or stopping in another window.');
        return { row: active, fresh: false };
      }
      const agent = await one(query, 'SELECT sip_username FROM hans_calling_agents WHERE crm_user_id=?', [userId]);
      if (!agent?.sip_username) throw fail(409, 'Connect browser audio first.');
      const id = randomUUID();
      await query('INSERT INTO hans_calling_sessions(id,crm_user_id,owner_token) VALUES(?,?,?)', [id,userId,owner]);
      return { row: { id }, fresh: true, username: agent.sip_username };
    });
    return fresh ? dial('audio', row, 'sip:' + username + '_' + need('PLIVO_AUTH_ID') + '@phone.plivo.com') : row;
  }
  async function startCall(userId, body) {
    if (!uuid(body.key) || !uuid(body.sessionId) || !uuid(body.owner) || !Number.isSafeInteger(Number(body.requestId))) throw fail(422,'Invalid call request.');
    configured();
    const { row, fresh } = await store.locked('user:' + userId, async query => {
      const existing = await one(query, 'SELECT * FROM hans_calling_calls WHERE crm_user_id=? AND idempotency_key=?', [userId,body.key]);
      if (existing) return { row: existing, fresh: false };
      const session = await one(query, `SELECT * FROM hans_calling_sessions WHERE id=? AND crm_user_id=? AND owner_token=?
        AND status='ready' AND ended_at IS NULL AND stop_requested=0`, [body.sessionId,userId,body.owner]);
      if (!session) throw fail(409, 'Audio is not ready. Reconnect before calling.');
      const active = await one(query, 'SELECT id FROM hans_calling_calls WHERE crm_user_id=? AND ended_at IS NULL LIMIT 1', [userId]);
      if (active) throw fail(409,'A call is already in progress.');
      const [lead] = await eligibleLeads(query,userId,Number(body.requestId));
      if (!lead) throw fail(422,'This lead is fresh, no longer requested, or does not belong to you.');
      const phone = normalizePhone(lead.phone);
      const from = phone.startsWith('+91') ? need('FROM_NUMBER_INDIA') : phone.startsWith('+1') ? need('FROM_NUMBER_US') : need('FROM_NUMBER_EU');
      const id = randomUUID();
      await query(`INSERT INTO hans_calling_calls(id,crm_user_id,request_id,session_id,idempotency_key,lead_id,lead_type,lead_name,phone,from_number)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [id,userId,lead.requestId,session.id,body.key,lead.leadId,lead.leadType,lead.name || '',phone,from]);
      await query('UPDATE hans_calling_sessions SET activity_at=UTC_TIMESTAMP(3) WHERE id=?', [session.id]);
      return { row: { id, phone, from_number: from }, fresh: true };
    });
    return fresh ? dial('call', row, row.phone) : row;
  }
  async function state(userId) {
    const session = await one(q, 'SELECT * FROM hans_calling_sessions WHERE crm_user_id=? ORDER BY created_at DESC LIMIT 1', [userId]);
    const call = await one(q, 'SELECT * FROM hans_calling_calls WHERE crm_user_id=? ORDER BY created_at DESC LIMIT 1', [userId]);
    return { session, call };
  }
  async function stopOwned(userId, body) {
    if (!uuid(body.sessionId) || !uuid(body.owner)) throw fail(422,'Invalid browser session.');
    const session = await get('audio', body.sessionId);
    if (!session || Number(session.crm_user_id) !== Number(userId) || session.owner_token !== body.owner) throw fail(403,'This audio session belongs to another window.');
    await store.locked('user:' + userId, async query => {
      await query('UPDATE hans_calling_sessions SET stop_requested=1 WHERE id=?', [session.id]);
      await query('UPDATE hans_calling_calls SET stop_requested=1 WHERE session_id=? AND ended_at IS NULL', [session.id]);
    });
    await stopSession(session.id);
    return { ok: true };
  }
  async function event(eventName, kind, id, body) {
    if (!['audio','call'].includes(kind) || !uuid(id)) return emptyXml;
    let row = await get(kind,id);
    if (!row) return emptyXml;
    const callUUID = body.CallUUID;
    if (callUUID && typeof callUUID === 'string') {
      if (row.call_uuid && row.call_uuid !== callUUID) throw fail(409, 'Provider call identifier mismatch.');
      await q(`UPDATE ${table(kind)} SET call_uuid=COALESCE(call_uuid,?) WHERE id=?`, [callUUID,id]);
    }
    if (eventName === 'hangup' || eventName === 'fallback') {
      await q(`UPDATE ${table(kind)} SET status='ended',ended_at=COALESCE(ended_at,UTC_TIMESTAMP(3)),hangup_cause=? WHERE id=?`, [String(body.HangupCauseName || body.HangupCause || eventName).slice(0,128),id]);
      if (kind === 'audio') await stopSession(id);
      else await q('UPDATE hans_calling_sessions SET activity_at=UTC_TIMESTAMP(3) WHERE id=?', [row.session_id]);
      return emptyXml;
    }
    if (eventName === 'recording' && kind === 'call') {
      const recordingId = body.recording_id || body.RecordingID || body.RecordId;
      if (typeof recordingId === 'string') await q('UPDATE hans_calling_calls SET recording_id=? WHERE id=?', [recordingId,id]);
      return emptyXml;
    }
    if (row.ended_at || row.stop_requested) {
      // A late conference callback can arrive after Request cancellation was acknowledged.
      if (callUUID) { try { await provider(`Call/${encodeURIComponent(callUUID)}/`, 'DELETE'); } catch (e) { if (![404,410].includes(e.status)) throw e; } }
      await stopLeg(kind,id); return emptyXml;
    }
    const session = kind === 'audio' ? row : await get('audio',row.session_id);
    if (!session || session.ended_at || session.stop_requested || (kind === 'call' && session.status !== 'ready')) {
      await stopLeg(kind,id); return emptyXml;
    }
    if (eventName === 'conference' && (body.ConferenceName !== 'crm-' + session.id || !body.ConferenceMemberID)) throw fail(400, 'Invalid conference membership.');
    if (eventName === 'answer') {
      const actor = await one(q, 'SELECT id FROM users WHERE id=? AND active_status=1 AND role IN (3,5,7)', [row.crm_user_id]);
      if (!actor) { await stopSession(session.id); return emptyXml; }
    }
    if (eventName === 'ring') await q(`UPDATE ${table(kind)} SET status='ringing' WHERE id=? AND status='starting' AND ended_at IS NULL`, [id]);
    if (eventName === 'conference' && body.ConferenceAction === 'enter') {
      if (kind === 'audio') await q(`UPDATE hans_calling_sessions SET status='ready',ready_at=COALESCE(ready_at,UTC_TIMESTAMP(3)),activity_at=UTC_TIMESTAMP(3)
        WHERE id=? AND ended_at IS NULL AND stop_requested=0`, [id]);
      else {
        await q(`UPDATE hans_calling_calls SET status='live',answered_at=COALESCE(answered_at,UTC_TIMESTAMP(3)) WHERE id=? AND ended_at IS NULL AND stop_requested=0`, [id]);
        if (process.env.RECORD_CALLS !== 'false' && callUUID) {
          const claim = await q('UPDATE hans_calling_calls SET recording_started=1 WHERE id=? AND recording_started=0 AND ended_at IS NULL', [id]);
          if (claim.affectedRows) {
            try {
              const recording = await provider(`Call/${encodeURIComponent(callUUID)}/Record/`, 'POST', { time_limit:14400,file_format:'mp3',record_channel_type:'stereo',
                callback_url:callback('recording',kind,id),callback_method:'POST' });
              if (recording.recording_id) await q('UPDATE hans_calling_calls SET recording_id=? WHERE id=?',[recording.recording_id,id]);
            } catch { await q('UPDATE hans_calling_calls SET recording_started=0 WHERE id=?',[id]); }
          }
        }
      }
    }
    if (eventName === 'conference' && body.ConferenceAction === 'exit' && kind === 'audio') await stopSession(id);
    if (eventName !== 'answer') return '<Response/>';
    return `<Response><Conference startConferenceOnEnter="true" endConferenceOnExit="${kind === 'audio'}" maxMembers="2" timeLimit="14400" enterSound="" exitSound="" callbackMethod="POST" callbackUrl="${xmlEscape(callback('conference',kind,id))}">crm-${session.id}</Conference></Response>`;
  }
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const sessions = await q(`SELECT s.id FROM hans_calling_sessions s WHERE s.ended_at IS NULL AND
        (s.stop_requested=1 OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id=s.crm_user_id AND u.active_status=1 AND u.role IN (3,5,7)) OR (s.status<>'ready' AND s.created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 90 SECOND)) OR
        (s.activity_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 120 SECOND) AND NOT EXISTS
        (SELECT 1 FROM hans_calling_calls c WHERE c.session_id=s.id AND c.ended_at IS NULL))) LIMIT 50`);
      for (const s of sessions) try { await stopSession(s.id); } catch { /* durable stop_requested retries next sweep */ }
      for (const kind of ['audio','call']) {
        // Provider time_limit is four hours. Even an unacknowledged dial cannot outlive this grace period.
        await q(`UPDATE ${table(kind)} SET status='ended',stop_requested=1,ended_at=COALESCE(ended_at,UTC_TIMESTAMP(3)),
          hangup_cause=COALESCE(hangup_cause,'provider_time_limit') WHERE ended_at IS NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 250 MINUTE)`);
        const rows = await q(`SELECT * FROM ${table(kind)} WHERE (stop_requested=1 AND ended_at IS NULL) OR
          (ended_at IS NOT NULL AND cost_usd IS NULL AND call_uuid IS NOT NULL AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 7 DAY)) OR
          (ended_at IS NULL AND call_uuid IS NOT NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 45 SECOND)) ORDER BY created_at DESC LIMIT 50`);
        for (const row of rows) {
          try {
            if (!row.ended_at && row.stop_requested) await stopLeg(kind,row.id);
            if (row.call_uuid) {
              const cdr = await provider(`Call/${encodeURIComponent(row.call_uuid)}/`);
              if (!row.ended_at && cdr.end_time) await event('hangup',kind,row.id,{CallUUID:row.call_uuid,HangupCauseName:cdr.hangup_cause_name || 'provider_completed'});
              if (cdr.total_amount != null) await q(`UPDATE ${table(kind)} SET cost_usd=?,bill_seconds=? WHERE id=?`, [Number(cdr.total_amount),Number(cdr.bill_duration || cdr.billed_duration || 0),row.id]);
            }
          } catch { /* provider/CDR availability is retried */ }
        }
      }
    } finally { sweeping = false; }
  }
  return { credentials, startAudio, startCall, state, stopOwned, event, sweep };
}
