import express from 'express';
import { Readable } from 'node:stream';
import { fetchRecording } from '../recordingTransport.js';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { one, fail, eligibleLeads } from './store.js';
import { createCallingService } from './service.js';
import { validWebhook, plivoRequest } from '../plivoTransport.js';

const COOKIE = 'hans_session';
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createCrmApp(store, { provider = plivoRequest, verifyWebhook = validWebhook } = {}) {
  const secret = process.env.SESSION_SECRET;
  const bridge = process.env.CRM_QUEUE_TOKEN;
  if (!secret || secret.length < 32 || !bridge || bridge.length < 32) throw new Error('CRM calling requires SESSION_SECRET and CRM_QUEUE_TOKEN of at least 32 characters.');
  const app = express();
  const service = createCallingService(store,provider);
  const q = store.query;
  const user = async id => {
    const row = await one(q,'SELECT id,name,email,mobile AS phone,role,active_status FROM users WHERE id=?',[id]);
    if (!row || Number(row.active_status)!==1 || ![3,5,7].includes(Number(row.role))) return null;
    return { ...row, role:'rep',storage:'crm',kind:'tse' };
  };
  const admin = async id => {
    const row = await one(q,'SELECT id,email FROM hans_calling_admins WHERE id=? AND active=1',[id]);
    return row ? { ...row,role:'admin',storage:'crm',kind:'admin' } : null;
  };
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    if (req.get('Origin') === process.env.CLIENT_ORIGIN) {
      res.set('Access-Control-Allow-Origin',process.env.CLIENT_ORIGIN); res.set('Access-Control-Allow-Credentials','true');
      res.set('Access-Control-Allow-Headers','Content-Type');res.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.vary('Origin');
      if(req.method==='OPTIONS')return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({limit:'16kb'}));
  app.use(express.urlencoded({extended:false,limit:'32kb'}));
  app.use(cookieParser());
  app.get('/health',async (_req,res) => { await q('SELECT 1'); res.json({ok:true,storage:'crm_mysql'}); });
  app.post('/webhooks/crm/:event',async (req,res) => {
    if (!verifyWebhook(req)) return res.sendStatus(403);
    const xml = await service.event(req.params.event,req.query.kind,req.query.id,req.body);
    res.type('text/xml').send(xml);
  });
  // Browser mutations must originate on the calling-line site. The CRM bridge uses its own bearer identity.
  app.use('/api',(req,res,next) => {
    if (req.path.startsWith('/integrations/crm/')) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const expected = [process.env.PUBLIC_URL,process.env.CLIENT_ORIGIN].filter(Boolean).map(url => new URL(url).origin);
      if (!req.get('Origin') || !expected.includes(req.get('Origin'))) return res.status(403).json({error:'Invalid request origin.'});
    }
    res.set('Cache-Control','no-store'); next();
  });
  const attempts = new Map();
  app.post('/api/login',async (req,res) => {
    const email=String(req.body.email || '').trim().toLowerCase();
    const key=req.ip + ':' + email;
    const now=Date.now();
    for (const [k,v] of attempts) if (now-v.at>900000) attempts.delete(k);
    const attempt=attempts.get(key) || {n:0,at:now};
    if (attempt.n>=10) throw fail(429,'Too many login attempts. Try again in 15 minutes.');
    attempt.n++; attempts.set(key,attempt);
    if (email.length>254 || typeof req.body.password!=='string' || req.body.password.length>1024) throw fail(401,'Bad email or password.');
    let identity=null;
    const existingAdmin=await one(q,'SELECT * FROM hans_calling_admins WHERE email=? AND active=1',[email]);
    if (existingAdmin && await bcrypt.compare(req.body.password,existingAdmin.password_hash)) identity=await admin(existingAdmin.id);
    if (!identity) {
      const row=await one(q,'SELECT id,password FROM users WHERE email=? AND active_status=1',[email]);
      if (row && await bcrypt.compare(req.body.password,String(row.password).replace(/^\$2y\$/,'$2b$'))) identity=await user(row.id);
    }
    if (!identity) throw fail(401,'Bad email or password.');
    attempts.delete(key);
    res.cookie(COOKIE,jwt.sign({uid:identity.id,kind:identity.kind,storage:'crm'},secret,{expiresIn:'12h'}),{
      httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:43200000,path:'/',
    });
    res.json(identity);
  });
  app.post('/api/logout',(_req,res) => { res.clearCookie(COOKIE,{path:'/'});res.json({ok:true}); });
  async function authenticated(req,res,next) {
    let claims;
    try { claims=jwt.verify(req.cookies[COOKIE],secret); } catch { throw fail(401,'Please log in.'); }
    if (claims.storage!=='crm') throw fail(401,'Please log in again.');
    req.actor=claims.kind==='admin' ? await admin(claims.uid) : await user(claims.uid);
    if (!req.actor) throw fail(401,'This login is inactive.');
    next();
  }
  app.get('/api/me',authenticated,(req,res) => res.json(req.actor));
  const router=express.Router();
  router.use((req,res,next) => { res.set('Cache-Control','no-store');next(); });
  router.get('/leads',async (req,res) => res.json({leads:await eligibleLeads(q,req.actor.id)}));
  router.post('/credentials',async (req,res) => res.json(await service.credentials(req.actor.id,req.body.owner)));
  router.post('/audio',async (req,res) => res.json(await service.startAudio(req.actor.id,req.body.owner)));
  router.post('/call',async (req,res) => res.json(await service.startCall(req.actor.id,req.body)));
  router.get('/state',async (req,res) => res.json(await service.state(req.actor.id)));
  router.post('/stop',async (req,res) => res.json(await service.stopOwned(req.actor.id,req.body)));
  app.use('/api/calling',authenticated,(req,_res,next) => { if(req.actor.role!=='rep') throw fail(403,'TSE login required for calling.'); next(); },router);
  app.use('/api/integrations/crm',async (req,res,next) => {
    if (!same(req.get('Authorization'),'Bearer '+bridge)) throw fail(401,'Invalid CRM bridge credential.');
    const id=Number(req.get('X-CRM-User-ID'));
    if (!Number.isSafeInteger(id) || id<=0) throw fail(401,'Invalid CRM identity.');
    req.actor=await user(id);
    if (!req.actor) throw fail(403,'Active CRM TSE login required.');
    next();
  },router);
  app.get('/api/crm-reports',authenticated,async (req,res) => {
    const page=Math.max(0,Number.parseInt(req.query.page,10)||0);
    const clauses=['1=1'],args=[];
    if(req.actor.role!=='admin') { clauses.push('c.crm_user_id=?'); args.push(req.actor.id); }
    else if(req.query.userId) { clauses.push('c.crm_user_id=?');args.push(Number(req.query.userId)); }
    for (const [param,operator] of [['from','>='],['to','<']]) {
      if(req.query[param]) {
        if(!/^\d{4}-\d{2}-\d{2}$/.test(req.query[param])) throw fail(422,'Invalid date.');
        clauses.push(`c.created_at ${operator} ${param==='to' ? 'DATE_SUB(DATE_ADD(?,INTERVAL 1 DAY),INTERVAL 330 MINUTE)' : 'DATE_SUB(?,INTERVAL 330 MINUTE)'}`);args.push(req.query[param]);
      }
    }
    const where=clauses.join(' AND ');
    const calls=await q(`SELECT c.*,u.name AS tse_name,u.email AS tse_email FROM hans_calling_calls c LEFT JOIN users u ON u.id=c.crm_user_id
      WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT 100 OFFSET ${Math.min(page,100000)*100}`,args);
    const [totals]=await q(`SELECT COUNT(*) AS calls,SUM(c.answered_at IS NOT NULL) AS connected,COALESCE(SUM(c.bill_seconds),0) AS bill_seconds,
      COALESCE(SUM(c.cost_usd),0) AS cost_usd FROM hans_calling_calls c WHERE ${where}`,args);
    const sessions=await q(`SELECT s.*,u.name AS tse_name FROM hans_calling_sessions s LEFT JOIN users u ON u.id=s.crm_user_id
      ${req.actor.role==='admin'?'':'WHERE s.crm_user_id=?'} ORDER BY s.created_at DESC LIMIT 100`,req.actor.role==='admin'?[]:[req.actor.id]);
    const agents=req.actor.role==='admin' ? await q('SELECT id,name,email FROM users WHERE active_status=1 AND role IN (3,5,7) ORDER BY name') : [];
    res.json({calls,totals,sessions,agents,page,usdToInr:Number(process.env.USD_TO_INR || 80)});
  });
  app.get('/api/crm-recordings/:id',authenticated,async (req,res) => {
    const call=await one(q,'SELECT crm_user_id,recording_id FROM hans_calling_calls WHERE id=?',[req.params.id]);
    if(!call || (req.actor.role!=='admin' && Number(call.crm_user_id)!==Number(req.actor.id))) throw fail(404,'Recording not found.');
    if(!call.recording_id) throw fail(404,'Recording is not available yet.');
    const recording=await provider('Recording/'+encodeURIComponent(call.recording_id)+'/');
    const url=new URL(recording.recording_url);
    if(url.protocol!=='https:') throw fail(502,'Invalid recording URL.');
    const media=await fetchRecording(url.toString(),req.headers.range ? {range:req.headers.range} : {});
    if(!media.ok || !media.body)throw fail(502,'Recording could not be downloaded.');
    res.status(media.status);
    for(const header of ['content-length','content-range','accept-ranges'])if(media.headers.get(header))res.set(header,media.headers.get(header));
    res.type('audio/mpeg');res.set('Cache-Control','private, no-store');
    const stream=Readable.fromWeb(media.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  });
  const out=fileURLToPath(new URL('../../../client/out/',import.meta.url));
  if(existsSync(out)) app.use(express.static(out));
  app.use('/api',(_req,res) => res.status(404).json({error:'Route not available in CRM mode.'}));
  app.use((error,_req,res,_next) => {
    if(!error.status) console.error('[crm-calling]',error.code || error.name);
    res.status(error.status || 500).json({error:error.status ? error.message : 'Calling service could not complete this request.'});
  });
  return {app,service};
}
