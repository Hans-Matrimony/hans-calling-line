import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { createStore, eligibleLeads } from '../src/crm/store.js';
import { createCrmApp } from '../src/crm/app.js';

// A fresh, loopback-only MySQL process. Never loads .env or connects to an existing database.
const binary=process.env.MYSQLD_PATH || 'D:/wamp64/bin/mysql/mysql9.1.0/bin/mysqld.exe';
const local=fileURLToPath(new URL('../../.local/',import.meta.url));await mkdir(local,{recursive:true});
const directory=await mkdtemp(join(local,'crm-mysql-test-'));
const datadir=join(directory,'data');await mkdir(datadir);
const logfile=await open(join(directory,'mysql.log'),'a');
const run=args=>spawn(binary,args,{windowsHide:true,stdio:['ignore',logfile.fd,logfile.fd]});
const initialize=run(['--no-defaults','--initialize-insecure','--datadir='+datadir]);
const [exit]=await once(initialize,'exit');assert.equal(exit,0,'MySQL initialization failed; inspect '+directory);
const port=33319;
const daemon=run(['--no-defaults','--datadir='+datadir,'--bind-address=127.0.0.1','--port='+port,'--mysqlx=OFF']);
let connection,store,http;
try {
  for(let i=0;i<100;i++){
    if(daemon.exitCode!==null)throw new Error('Isolated MySQL exited; inspect '+directory);
    try{connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',connectTimeout:1000});break;}
    catch{await new Promise(resolve=>setTimeout(resolve,300));}
  }
  assert.ok(connection,'Isolated MySQL did not start');
  await connection.query('CREATE DATABASE hans_calling_test');
  Object.assign(process.env,{CRM_DB_HOST:'127.0.0.1',CRM_DB_PORT:String(port),CRM_DB_NAME:'hans_calling_test',CRM_DB_USER:'root',CRM_DB_PASSWORD:'',
    SESSION_SECRET:'s'.repeat(40),CRM_QUEUE_TOKEN:'t'.repeat(40),PUBLIC_URL:'https://calling.example.test',CLIENT_ORIGIN:'https://calling.example.test',
    PLIVO_AUTH_ID:'mock-id',PLIVO_AUTH_TOKEN:'mock-token',PLIVO_APPLICATION_ID:'mock-app',FROM_NUMBER_INDIA:'+918000000000',FROM_NUMBER_US:'+12025550100',FROM_NUMBER_EU:'+442000000000'});
  store=createStore();const q=store.query;await store.migrate();await store.migrate();
  for(const sql of [
    'CREATE TABLE users(id BIGINT PRIMARY KEY,name VARCHAR(100),email VARCHAR(254),password VARCHAR(255),mobile VARCHAR(30),role INT,active_status INT)',
    'CREATE TABLE user_request_leads(id BIGINT PRIMARY KEY,user_id BIGINT,lead_id BIGINT,lead_type INT,lead_status VARCHAR(30),created_at DATETIME)',
    'CREATE TABLE leads(id BIGINT PRIMARY KEY,user_data_id BIGINT,created_at DATETIME)',
    'CREATE TABLE user_data(id BIGINT PRIMARY KEY,name VARCHAR(100),user_mobile VARCHAR(30))',
    'CREATE TABLE incomplete_leads(id BIGINT PRIMARY KEY,full_name VARCHAR(100),user_phone VARCHAR(30),created_at DATETIME,meta_date DATETIME NULL)',
  ])await q(sql);
  const hash=await bcrypt.hash('test-password',4);
  await q('INSERT INTO users VALUES(7,?,?,?,?,5,1),(8,?,?,?,?,5,1)', ['TSE Seven','seven@test.invalid',hash.replace('$2b$','$2y$'),'9876543210','TSE Eight','eight@test.invalid',hash,'9876543211']);
  await q("INSERT INTO incomplete_leads VALUES (10,'Old New-type lead','9876543210',DATE_SUB(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 330 MINUTE),INTERVAL 3 DAY),NULL),(11,'Fresh','9876543211',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 330 MINUTE),NULL),(12,'Old created fresh meta','9876543212',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 5 DAY),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 330 MINUTE))");
  await q("INSERT INTO user_data VALUES(20,'Website','9876543220')");
  await q('INSERT INTO leads VALUES(10,20,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 5 DAY))');
  for(const row of [[1,7,10,1,'requested'],[2,7,11,1,'requested'],[3,8,10,1,'requested'],[4,7,10,1,'picked'],[5,7,10,0,'requested'],[6,7,12,9,'requested']])
    await q('INSERT INTO user_request_leads VALUES(?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 330 MINUTE))',row);
  const before=JSON.stringify(await q('SELECT * FROM user_request_leads ORDER BY id'));
  const eligible=await eligibleLeads(q,7);
  assert.deepEqual(eligible.map(l=>l.requestId),[5,1]);assert.equal(eligible[0].phone,'9876543220');
  let providerCalls=[],requestCounter=0;
  const provider=async (path,method='GET',body)=>{
    providerCalls.push({path,method,body});
    if(path==='Endpoint/')return {endpoint_id:'endpoint-7',username:'tse-seven'};
    if(path==='JWT/Token/')return {token:'browser-token'};
    if(path==='Call/' && method==='POST')return {request_uuid:'request-'+ ++requestCounter};
    if(path.endsWith('/Record/'))return {recording_id:'recording-1'};
    if(method==='DELETE')return {};
    if(path.startsWith('Recording/'))return {recording_url:'https://media.example.test/recording.mp3'};
    return {total_amount:'0.01',bill_duration:'3'};
  };
  const {app,service}=createCrmApp(store,{provider,verifyWebhook:req=>req.get('x-test-signature')==='valid'});
  http=app.listen(0,'127.0.0.1');await once(http,'listening');const base='http://127.0.0.1:'+http.address().port;
  const request=async(path,{body,cookie,bridge=false,origin=true,signature}={})=>{
    const res=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:process.env.PUBLIC_URL}:{}),...(cookie?{Cookie:cookie}:{}),...(bridge?{Authorization:'Bearer '+process.env.CRM_QUEUE_TOKEN,'X-CRM-User-ID':'7'}:{}),...(signature?{'x-test-signature':signature}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {res,data:await res.text()};
  };
  const login=await request('/api/login',{body:{email:'seven@test.invalid',password:'test-password'}});assert.equal(login.res.status,200,login.data);
  const cookie=login.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/calling/leads',{cookie})).res.status,200);
  assert.equal((await request('/api/calling/audio',{cookie,body:{owner:randomUUID()},origin:false})).res.status,403);
  assert.equal((await request('/api/integrations/crm/state')).res.status,401);
  assert.equal((await request('/api/integrations/crm/state',{bridge:true,origin:false})).res.status,200);
  const owner=randomUUID();await service.credentials(7,owner);
  const session=await service.startAudio(7,owner);
  await assert.rejects(service.startAudio(7,randomUUID()),e=>e.status===409);
  const key=randomUUID(),body={owner,sessionId:session.id,key,requestId:1};
  await assert.rejects(service.startCall(7,body),e=>e.status===409);
  await service.event('answer','audio',session.id,{CallUUID:'rep-uuid'});
  await assert.rejects(service.startCall(7,body),e=>e.status===409);
  await service.event('conference','audio',session.id,{CallUUID:'rep-uuid',ConferenceAction:'enter',ConferenceName:'crm-'+session.id,ConferenceMemberID:'1'});
  for(const requestId of [2,3,4,6])await assert.rejects(service.startCall(7,{...body,key:randomUUID(),requestId}),e=>e.status===422);
  const [call,duplicate]=await Promise.all([service.startCall(7,body),service.startCall(7,body)]);assert.equal(call.id,duplicate.id);
  assert.equal(providerCalls.filter(c=>c.path==='Call/' && c.method==='POST').length,2,'one audio + one customer call');
  await assert.rejects(service.startCall(7,{...body,key:randomUUID()}),e=>e.status===409);
  await assert.rejects(service.stopOwned(8,{owner,sessionId:session.id}),e=>e.status===403);
  const xml=await service.event('answer','call',call.id,{CallUUID:'lead-uuid'});assert.match(xml,/crm-/);
  await service.event('conference','call',call.id,{CallUUID:'lead-uuid',ConferenceAction:'enter',ConferenceName:'crm-'+session.id,ConferenceMemberID:'1'});
  await service.event('conference','call',call.id,{CallUUID:'lead-uuid',ConferenceAction:'enter',ConferenceName:'crm-'+session.id,ConferenceMemberID:'1'});
  assert.equal(providerCalls.filter(c=>c.path.endsWith('/Record/')).length,1,'duplicate conference callback must not duplicate recording');
  await service.event('hangup','call',call.id,{CallUUID:'lead-uuid',HangupCause:'NORMAL_CLEARING'});
  await service.event('conference','call',call.id,{CallUUID:'lead-uuid',ConferenceAction:'enter',ConferenceName:'crm-'+session.id,ConferenceMemberID:'1'});
  assert.equal((await service.state(7)).call.status,'ended','late callback must not resurrect ended call');
  assert.ok((await eligibleLeads(q,7)).some(l=>l.requestId===1),'previous calls must not remove requested lead');
  const redial=await service.startCall(7,{...body,key:randomUUID()});assert.notEqual(redial.id,call.id);
  await service.stopOwned(7,{owner,sessionId:session.id});await service.sweep();
  assert.ok((await service.state(7)).session.ended_at);
  assert.equal(before,JSON.stringify(await q('SELECT * FROM user_request_leads ORDER BY id')),'calling must not change CRM pick/not-pick records');
  await q('INSERT INTO hans_calling_admins VALUES(?,?,?,1)',['legacy-admin','admin@test.invalid',hash]);
  const adminLogin=await request('/api/login',{body:{email:'admin@test.invalid',password:'test-password'}});assert.equal(adminLogin.res.status,200);
  const adminCookie=adminLogin.res.headers.get('set-cookie').split(';')[0];
  const reports=await request('/api/crm-reports',{cookie:adminCookie});assert.equal(reports.res.status,200);assert.equal(JSON.parse(reports.data).calls.length,2);
  assert.equal((await request('/api/calling/leads',{cookie:adminCookie})).res.status,403);
  // Auto Calling consumes only a CRM-owned durable reservation, never arbitrary browser phone data.
  await q("ALTER TABLE users ADD temple_id VARCHAR(40)");
  await q("ALTER TABLE incomplete_leads ADD request_by VARCHAR(40), ADD isDelete INT DEFAULT 0");
  await q("ALTER TABLE leads ADD request_by VARCHAR(40), ADD is_done INT DEFAULT 2, ADD is_deleted INT DEFAULT 0");
  await q("UPDATE users SET temple_id='temple-seven' WHERE id=7");
  await q("UPDATE incomplete_leads SET request_by='temple-seven' WHERE id IN (10,11)");
  const autoId=randomUUID(),freshId=randomUUID(),foreignId=randomUUID();
  for(const [id,user,leadId,phone] of [[autoId,7,10,'+919876543210'],[freshId,8,11,'+919876543211'],[foreignId,9,10,'+919876543212']]) {
    await q(`INSERT INTO hans_calling_auto_leads(id,crm_user_id,active_user,active_phone,lead_id,lead_type,lead_name,phone,created_at,updated_at)
      VALUES(?,?,?,?,?,1,'Auto test',?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[id,user,user,phone,leadId,phone]);
  }
  const autoOwner=randomUUID();await service.credentials(7,autoOwner);const autoAudio=await service.startAudio(7,autoOwner);
  const autoBody={owner:autoOwner,sessionId:autoAudio.id,autoLeadId:autoId,key:autoId,phone:'+19999999999',requestId:9999};
  await assert.rejects(service.startCall(7,autoBody),e=>e.status===409);
  await service.event('conference','audio',autoAudio.id,{CallUUID:'auto-rep',ConferenceAction:'enter',ConferenceName:'crm-'+autoAudio.id,ConferenceMemberID:'1'});
  await assert.rejects(service.startCall(7,{...autoBody,autoLeadId:foreignId,key:foreignId}),e=>e.status===422);
  await assert.rejects(service.startCall(7,{...autoBody,key:randomUUID()}),e=>e.status===422);
  await q('UPDATE hans_calling_auto_leads SET lead_id=11,phone=? WHERE id=?',['+919876543211',autoId]);
  await assert.rejects(service.startCall(7,autoBody),e=>e.status===422,'Fresh cannot be called even with a reservation');
  await q('UPDATE hans_calling_auto_leads SET lead_id=10,phone=? WHERE id=?',['+919876543210',autoId]);
  const autoBefore=providerCalls.filter(c=>c.path==='Call/' && c.method==='POST').length;
  const [autoCall,autoRetry]=await Promise.all([service.startCall(7,autoBody),service.startCall(7,autoBody)]);
  assert.equal(autoCall.id,autoRetry.id);assert.equal(autoCall.phone,'+919876543210');assert.equal(autoCall.request_id,0);
  assert.equal(providerCalls.filter(c=>c.path==='Call/' && c.method==='POST').length,autoBefore+1);
  await service.event('answer','call',autoCall.id,{CallUUID:'auto-customer'});
  assert.ok((await service.state(7)).call.answered_at,'Plivo answer supplies Pick suggestion even before the conference callback');
  await service.event('hangup','call',autoCall.id,{CallUUID:'auto-customer',HangupCause:'NORMAL_CLEARING'});
  await q("UPDATE hans_calling_auto_leads SET status='completed',outcome='add_lead',disposition='pick',active_user=NULL,active_phone=NULL WHERE id=?",[autoId]);
  assert.equal((await service.startCall(7,autoBody)).id,autoCall.id,'completed retry returns the same call without redialing');
  const autoReport=JSON.parse((await request('/api/crm-reports',{cookie:adminCookie})).data);
  const autoReported=autoReport.calls.find(c=>c.id===autoCall.id);assert.equal(autoReported.queue,'auto');assert.equal(autoReported.outcome,'add_lead');
  await service.stopOwned(7,{owner:autoOwner,sessionId:autoAudio.id});
  assert.equal(before,JSON.stringify(await q('SELECT * FROM user_request_leads ORDER BY id')));
  await q('UPDATE users SET active_status=0 WHERE id=7');assert.equal((await request('/api/me',{cookie})).res.status,401);
  assert.equal((await request('/webhooks/crm/answer?kind=audio&id='+session.id,{body:{}})).res.status,403);
  console.log('PASS: real MySQL migration, Fresh filtering, CRM credentials, ownership, audio gating, concurrency, idempotency, redial, callbacks, recordings, stop, reports unchanged CRM status, Auto Calling ownership, Fresh revalidation and auto retry deduplication.');
} finally {
  if(http)await new Promise(resolve=>http.close(resolve));
  if(store)await store.close();
  if(connection){try{await connection.query('SHUTDOWN');}catch{}await connection.end();}
  if(daemon.exitCode===null){daemon.kill();await once(daemon,'exit');}
  await logfile.close();
}
