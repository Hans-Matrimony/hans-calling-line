import { createHash } from 'node:crypto';
import { normalizePhone, one, fail } from './store.js';
import { publicUrl } from '../plivoTransport.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const hangup = '<Response><Hangup/></Response>';
const unavailable = '<Response><Speak>Sorry, your representative is unavailable. Please try again later.</Speak><Hangup/></Response>';
const phone = value => {
  if (typeof value !== 'string' || !/^[+\d\s()-]+$/.test(value)) return null;
  try { return normalizePhone(value); } catch { return null; }
};
const callId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function createInboundService(store) {
  const q = store.query;
  const get = id => one(q,'SELECT * FROM hans_calling_inbound_calls WHERE call_uuid=?',[id]);
  const url = (event,id) => publicUrl()+'/webhooks/crm/inbound/'+event+'?'+new URLSearchParams({id});
  const numbers = () => ['FROM_NUMBER_INDIA','FROM_NUMBER_US','FROM_NUMBER_EU'].map(key=>phone(process.env[key])).filter(Boolean);
  function xml(row) {
    if (row.ended_at || row.status==='unroutable' || !row.destination) return unavailable;
    return '<Response><Dial callerId="'+escape(row.to_number)+'" timeout="30" timeLimit="14400" method="POST" action="'+
      escape(url('complete',row.call_uuid))+'" callbackMethod="POST" callbackUrl="'+escape(url('status',row.call_uuid))+
      '"><Number>'+escape(row.destination)+'</Number></Dial></Response>';
  }
  async function answer(body) {
    if (process.env.CRM_INBOUND_MOBILE_ENABLED !== 'true') return unavailable;
    const from=phone(body.From), to=phone(body.To), id=body.CallUUID;
    if (!from || !to || !callId(id) || !numbers().includes(to) || String(body.Direction).toLowerCase()!=='inbound') return unavailable;
    return store.locked('inbound:'+createHash('sha256').update(id).digest('hex').slice(0,32), async query=>{
      const existing=await one(query,'SELECT * FROM hans_calling_inbound_calls WHERE call_uuid=?',[id]);
      if(existing) {
        if(existing.from_number!==from || existing.to_number!==to) throw fail(400,'Inbound call identity mismatch.');
        return xml(existing);
      }
      // Select the last actual Auto Calling attempt before checking that TSE.
      // An inactive last TSE must not route the caller to an older owner.
      const last=await one(query,`SELECT c.id,c.crm_user_id,s.mobile,u.role,u.active_status
        FROM hans_calling_calls c LEFT JOIN users u ON u.id=c.crm_user_id
        LEFT JOIN hans_calling_inbound_settings s ON s.crm_user_id=c.crm_user_id
        WHERE c.request_id=0 AND c.phone=? AND REPLACE(c.from_number,'+','')=?
          AND (c.call_uuid IS NOT NULL OR c.request_uuid IS NOT NULL)
          AND COALESCE(c.hangup_cause,'')<>'provider_rejected'
        ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,[from,to.slice(1)]);
      const fallback='+919697989697';
      let destination=fallback,reason=null;
      if(last && Number(last.active_status)===1 && [3,5,7].includes(Number(last.role))) {
        destination=phone(last.mobile) || fallback;
      }
      // Never dial the caller or one of our own Plivo numbers.
      if(destination===from || numbers().includes(destination)) destination=fallback;
      if(destination===from || numbers().includes(destination)) { destination=null;reason='routing_loop'; }
      await query(`INSERT INTO hans_calling_inbound_calls
        (call_uuid,from_number,to_number,crm_user_id,outbound_call_id,destination,status,hangup_cause,ended_at)
        VALUES(?,?,?,?,?,?,?,?,IF(? IS NULL,NULL,UTC_TIMESTAMP(3)))`,
        [id,from,to,last?.crm_user_id ?? null,last?.id ?? null,destination,destination?'ringing':'unroutable',reason,reason]);
      return xml(await one(query,'SELECT * FROM hans_calling_inbound_calls WHERE call_uuid=?',[id]));
    });
  }
  async function event(eventName,id,body) {
    if(!['status','complete','hangup'].includes(eventName) || !callId(id)) throw fail(400,'Invalid inbound callback.');
    const row=await get(id);
    if(!row) return hangup;
    const identity=body.DialALegUUID || body.CallUUID;
    if(identity!==id) throw fail(400,'Inbound call identity mismatch.');
    if(eventName==='status' && ['answer','connected'].includes(body.DialAction)) {
      await q(`UPDATE hans_calling_inbound_calls SET status=IF(ended_at IS NULL,'connected',status),
        answered_at=COALESCE(answered_at,UTC_TIMESTAMP(3)), b_leg_uuid=COALESCE(b_leg_uuid,?)
        WHERE call_uuid=? AND destination IS NOT NULL`,[callId(body.DialBLegUUID)?body.DialBLegUUID:null,id]);
    }
    if(eventName!=='status' || body.DialAction==='hangup') {
      const duration=Number(body.DialBLegBillDuration);
      await q(`UPDATE hans_calling_inbound_calls SET status=IF(status='unroutable',status,'ended'),
        ended_at=COALESCE(ended_at,UTC_TIMESTAMP(3)),b_leg_uuid=COALESCE(b_leg_uuid,?),
        bill_seconds=COALESCE(?,bill_seconds),hangup_cause=COALESCE(?,hangup_cause)
        WHERE call_uuid=?`,[callId(body.DialBLegUUID)?body.DialBLegUUID:null,
        body.DialBLegBillDuration!=null && Number.isSafeInteger(duration) && duration>=0?Math.min(duration,14400):null,
        String(body.DialBLegHangupCauseName || body.DialHangupCause || body.HangupCauseName || body.HangupCause || body.DialStatus || '').slice(0,128) || null,id]);
    }
    return hangup;
  }
  return {answer,event};
}
