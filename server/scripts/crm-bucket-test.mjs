import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Called only by the fresh loopback MySQL harness; provider calls are mocked.
export async function testBucketCalling(store, service, providerCalls) {
  const q=store.query;
  await q('ALTER TABLE leads ADD assign_to VARCHAR(40), ADD deleted_at DATETIME NULL');
  await q("UPDATE users SET temple_id='temple-eight' WHERE id=8");
  for (const [id,temple,done,deleted,flag] of [[30,'temple-seven',0,null,0],[31,'temple-eight',0,null,0],
    [32,'temple-seven',1,null,0],[33,'temple-seven',0,'2026-10-01 00:00:00',0],[34,'temple-seven',0,null,1]]) {
    await q('INSERT INTO leads(id,user_data_id,assign_to,is_done,deleted_at,is_deleted) VALUES(?,20,?,?,?,?)',[id,temple,done,deleted,flag]);
  }
  const sessionId=randomUUID(),owner=randomUUID();
  await q("INSERT INTO hans_calling_sessions(id,crm_user_id,owner_token,status) VALUES(?,7,?,'ready')",[sessionId,owner]);
  const body={sessionId,owner,bucketLeadId:30,key:randomUUID()};
  const count=()=>providerCalls.filter(call=>call.path==='Call/' && call.method==='POST').length;
  const before=count();
  for (const bucketLeadId of [31,32,33,34,999,-1,'invalid'])
    await assert.rejects(service.startCall(7,{...body,bucketLeadId,key:randomUUID()}),e=>e.status===422);
  for (const extra of [{manualPhone:'+919999999999'},{requestId:1},{autoLeadId:randomUUID()}])
    await assert.rejects(service.startCall(7,{...body,...extra}),e=>e.status===422);
  assert.equal(count(),before,'Foreign/inactive bucket leads must never reach provider');
  const [first,retry]=await Promise.all([service.startCall(7,{...body,phone:'+919999999999'}),service.startCall(7,body)]);
  assert.equal(first.id,retry.id); assert.equal(count(),before+1);
  const saved=(await q('SELECT * FROM hans_calling_calls WHERE id=?',[first.id]))[0];
  assert.equal(saved.request_id,-3); assert.equal(saved.lead_id,30); assert.equal(saved.lead_type,0);
  assert.equal(saved.phone,'+919876543220'); assert.equal(saved.crm_user_id,7);
  await service.event('hangup','call',first.id,{CallUUID:'bucket-customer',HangupCause:'NORMAL_CLEARING'});
  await q("UPDATE leads SET assign_to='temple-eight' WHERE id=30");
  await assert.rejects(service.startCall(7,{...body,key:randomUUID()}),e=>e.status===422);
  assert.equal((await service.startCall(7,body)).id,first.id,'Retry does not redial even after reassignment');
  await q("UPDATE leads SET assign_to='temple-seven' WHERE id=30");
  await q("UPDATE user_data SET user_mobile='invalid' WHERE id=20");
  await assert.rejects(service.startCall(7,{...body,key:randomUUID()}),e=>e.status===422);
  await q("UPDATE user_data SET user_mobile='9876543220' WHERE id=20");
  const manual=await service.startCall(7,{sessionId,owner,key:randomUUID(),manualPhone:'+919876543221'});
  assert.equal((await q('SELECT request_id FROM hans_calling_calls WHERE id=?',[manual.id]))[0].request_id,-1);
  await service.event('hangup','call',manual.id,{CallUUID:'bucket-test-manual',HangupCause:'NORMAL_CLEARING'});
  await service.stopOwned(7,{sessionId,owner});
  console.log('PASS: Bucket Assigned Leads ownership, deletion/status checks, distinct category, server phone resolution, concurrent idempotency and manual separation.');
  return first.id;
}
