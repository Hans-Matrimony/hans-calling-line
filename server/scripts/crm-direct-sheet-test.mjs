import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function testDirectSheetCalling(store,service,providerCalls,request,cookie) {
  const q=store.query;
  await q(`CREATE TABLE direct_sheet_leads(id BIGINT PRIMARY KEY,work_tse_id BIGINT,full_name VARCHAR(255),user_phone VARCHAR(30),crm_profile_id BIGINT NULL)`);
  await q(`INSERT INTO direct_sheet_leads VALUES(1,7,'Direct own','9876543210',NULL),(2,8,'Other TSE','9876543211',NULL),(3,7,'Added','9876543212',99),(4,7,'Invalid','no phone',NULL)`);
  const sessionId=randomUUID(),owner=randomUUID();
  await q("INSERT INTO hans_calling_sessions(id,crm_user_id,owner_token,status) VALUES(?,7,?,'ready')",[sessionId,owner]);
  const body={sessionId,owner,key:randomUUID(),directSheetLeadId:1};
  const count=()=>providerCalls.filter(c=>c.path==='Call/' && c.method==='POST').length;
  const before=count();
  await assert.rejects(service.startCall(7,body),e=>e.status===403);
  assert.equal((await request('/api/calling/call',{cookie,body})).res.status,403);
  assert.equal((await request('/api/integrations/crm/call',{body})).res.status,401);
  for(const id of [2,3,4,999,-1,'invalid']) await assert.rejects(service.startCall(7,{...body,directSheetLeadId:id},{crmBridge:true}),e=>e.status===422);
  for(const extra of [{bucketLeadId:30},{manualPhone:'+919999999999'},{autoLeadId:randomUUID()},{requestId:1}])
    await assert.rejects(service.startCall(7,{...body,...extra},{crmBridge:true}),e=>e.status===422);
  assert.equal(count(),before);
  const [first,retry]=await Promise.all([
    request('/api/integrations/crm/call',{bridge:true,body:{...body,phone:'+919999999999'}}),
    request('/api/integrations/crm/call',{bridge:true,body})]);
  assert.equal(first.res.status,200,first.data); assert.equal(retry.res.status,200,retry.data);
  const id=JSON.parse(first.data).id;assert.equal(JSON.parse(retry.data).id,id);assert.equal(count(),before+1);
  const saved=(await q('SELECT * FROM hans_calling_calls WHERE id=?',[id]))[0];
  assert.equal(saved.request_id,-4);assert.equal(saved.lead_id,1);assert.equal(saved.phone,'+919876543210');
  await service.event('hangup','call',id,{CallUUID:'direct-test',HangupCause:'NORMAL_CLEARING'});
  await q('UPDATE direct_sheet_leads SET crm_profile_id=88 WHERE id=1');
  await assert.rejects(service.startCall(7,{...body,key:randomUUID()},{crmBridge:true}),e=>e.status===422);
  assert.equal((await service.startCall(7,body,{crmBridge:true})).id,id);
  await service.stopOwned(7,{sessionId,owner});
  console.log('PASS: Direct Sheet trusted bridge, ownership, picked/invalid checks, category, phone resolution, concurrent retry and no duplicate dialing.');
  return id;
}
