import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInboundService } from '../src/crm/inbound.js';

// Runs only with the fresh database created by test-crm-mysql.mjs. No provider calls.
export async function testInboundRouting(store) {
  const q = store.query;
  const inbound = createInboundService(store);
  process.env.CRM_INBOUND_MOBILE_ENABLED = 'true';
  await q("INSERT INTO hans_calling_inbound_settings(crm_user_id,mobile,updated_by,updated_at) VALUES(7,'+919000000007',7,UTC_TIMESTAMP()),(8,'+919000000008',7,UTC_TIMESTAMP())");
  const caller = '+919111111111', to = process.env.FROM_NUMBER_INDIA;
  const fallback = '+919697989697';
  let sequence = 0;
  async function seed(user, requestId, options = {}) {
    const id = randomUUID();
    await q(`INSERT INTO hans_calling_calls
      (id,crm_user_id,request_id,session_id,idempotency_key,lead_id,lead_type,phone,from_number,status,request_uuid,hangup_cause,created_at)
      VALUES(?,?,?,?,?,1,1,?,?,'ended',?,?,?)`,
      [id,user,requestId,randomUUID(),randomUUID(),caller,options.from || to,
       options.noProvider ? null : randomUUID(),options.cause || null,
       '2026-01-01 10:00:'+String(++sequence).padStart(2,'0')]);
    return id;
  }
  async function check(expectedUser, expectedDestination, id = randomUUID()) {
    const body = {From:caller,To:to,CallUUID:id,Direction:'inbound'};
    const xml = await inbound.answer(body);
    assert.ok(xml.includes('<Number>'+expectedDestination+'</Number>'), xml);
    const row = (await q('SELECT * FROM hans_calling_inbound_calls WHERE call_uuid=?',[id]))[0];
    assert.equal(row.crm_user_id,expectedUser);
    assert.equal(row.destination,expectedDestination);
    return {id,body,xml,row};
  }
  await check(null,fallback);
  const auto = await seed(7,0);
  assert.equal((await check(7,'+919000000007')).row.outbound_call_id,auto);
  const requested = await seed(8,42);
  assert.equal((await check(8,'+919000000008')).row.outbound_call_id,requested);
  const manual = await seed(7,-1);
  const sticky = await check(7,'+919000000007');
  assert.equal(sticky.row.outbound_call_id,manual);
  await seed(8,43);
  await check(8,'+919000000008');
  assert.equal(await inbound.answer(sticky.body),sticky.xml,'Retry must retain original route');
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM hans_calling_inbound_calls WHERE call_uuid=?',[sticky.id]))[0].n),1);
  await seed(7,-1,{cause:'provider_rejected'});
  await seed(7,0,{noProvider:true});
  await seed(7,0,{from:process.env.FROM_NUMBER_US});
  await seed(7,-2);
  await check(8,'+919000000008');
  await q('UPDATE users SET active_status=0 WHERE id=8');
  await check(8,fallback); // Never fall back to an older owner.
  await q('UPDATE users SET active_status=1,role=1 WHERE id=8');
  await check(8,fallback);
  await q('UPDATE users SET role=5 WHERE id=8');
  await q('UPDATE hans_calling_inbound_settings SET mobile=NULL WHERE crm_user_id=8');
  await check(8,fallback);
  await q('UPDATE hans_calling_inbound_settings SET mobile=? WHERE crm_user_id=8',[caller]);
  await check(8,fallback);
  await q('UPDATE hans_calling_inbound_settings SET mobile=? WHERE crm_user_id=8',[to]);
  await check(8,fallback);
  await q("UPDATE hans_calling_inbound_settings SET mobile='9000000008' WHERE crm_user_id=8");
  await check(8,'+919000000008');
  const disabledId = randomUUID();
  process.env.CRM_INBOUND_MOBILE_ENABLED = 'false';
  assert.ok(!(await inbound.answer({From:caller,To:to,CallUUID:disabledId,Direction:'inbound'})).includes('<Dial'));
  assert.equal((await q('SELECT call_uuid FROM hans_calling_inbound_calls WHERE call_uuid=?',[disabledId])).length,0);
  console.log('PASS: inbound last TSE across Auto, Request Leads and Manual Dial; sticky retries, failed submissions, inactive users, missing numbers and loop protection.');
}
