const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const widget=fs.readFileSync(path.join(__dirname,'../public/calling/widget.js'),'utf8');
const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body><div id="hans-calling-notice"></div><table><tbody id="rows"><tr><td>Old requested</td><td><button class="btnPickup" id="10" mobile="9876543210">Pickup</button></td></tr><tr><td>Fresh</td><td><button class="btnPickup" id="11" mobile="9876543211">Pickup</button></td></tr></tbody></table></body></html>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const browser=await playwright.chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  const errors=[];let page;
  try {
    page=await browser.newPage({viewport:{width:1100,height:750}});page.on('pageerror',e=>errors.push(e.message));
    let leads=[{requestId:1,leadId:10,leadType:1,name:'Old requested',phone:'9876543210'}],writes=[],audioReady=false,state={session:null,call:null},audioOwner,denyMic=false,holdAudio=false;
    await page.addInitScript(()=>{
      window.HansCallingConfig={base:'/crm/calling',sdk:'/mock-plivo.js',csrf:'test-csrf'};
      window.micCount=0;window.denyMic=false;
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{window.micCount++;if(window.denyMic)throw new DOMException('Permission denied','NotAllowedError');return{getTracks:()=>[{stop(){}}]};}}});
      window.Plivo=class {
        constructor(){const handlers={};const client={on:(name,fn)=>{handlers[name]=fn;},removeAllListeners:()=>{},setRingTone:()=>{},setConnectTone:()=>{},
          loginWithAccessToken:()=>{setTimeout(()=>handlers.onLogin(),10);return true;},answer:id=>{setTimeout(()=>handlers.onCallAnswered({callUUID:id}),10);return true;},reject:()=>{},hangup:()=>{},logout:()=>{},mute:()=>{},unmute:()=>{}};
          window.incoming=()=>handlers.onIncomingCall('caller',{}, {callUUID:'rep-uuid'});this.client=client;}
      };
    });
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();
      const p=url.pathname;if(!p.startsWith('/crm/calling/'))return route.continue();
      const body=req.method()==='POST'?req.postDataJSON():null;if(body)writes.push({p,body});
      let result={};
      if(p.endsWith('/leads'))result={leads};
      else if(p.endsWith('/credentials'))result={token:'test-token'};
      else if(p.endsWith('/audio')){
        audioOwner=body.owner;state.session={id:'audio-session',owner_token:audioOwner,status:'starting',ended_at:null,stop_requested:0};
        if(holdAudio)await new Promise(resolve=>setTimeout(resolve,1200));
        result=state.session;await page.evaluate(()=>window.incoming());
      } else if(p.endsWith('/state')){if(state.session)state.session.status=audioReady?'ready':'starting';result=state;}
      else if(p.endsWith('/call')){assert.ok(audioReady,'customer call must wait for server ready');state.call={id:'customer-call',status:'ringing',ended_at:null};result=state.call;}
      else if(p.endsWith('/stop')){if(state.session)state.session.ended_at='2026-09-22 10:00:00';if(state.call)state.call.ended_at='2026-09-22 10:00:00';result={ok:true};}
      else throw new Error('Unexpected endpoint '+p);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    const boot=async()=>{writes=[];audioReady=false;state={session:null,call:null};await page.goto(base);await page.addScriptTag({content:widget});await page.waitForFunction(()=>document.querySelectorAll('[data-hans-request]').length===1);};
    await boot();assert.equal(await page.evaluate(()=>window.micCount),0,'page load must not request microphone');
    assert.equal(await page.locator('tr').nth(1).getByRole('button',{name:'Call',exact:true}).count(),0,'fresh row has no Call button');
    await page.getByRole('button',{name:'Call',exact:true}).click();await page.waitForFunction(()=>window.micCount===1);
    await page.waitForTimeout(1000);assert.equal(writes.filter(w=>w.p.endsWith('/call')).length,0,'SDK audio alone must not dial');
    await page.getByRole('button',{name:'Call',exact:true}).click();audioReady=true;
    await page.waitForFunction(()=>document.querySelector('[data-status]').textContent==='Calling lead...');
    assert.equal(writes.filter(w=>w.p.endsWith('/call')).length,1,'double click sends one call');
    await page.getByRole('button',{name:'Mute',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Unmute',exact:true}).count(),1);
    state.call.ended_at='2026-09-22 10:00:00';state.call.hangup_cause='NORMAL_CLEARING';
    await page.getByRole('button',{name:'Close',exact:true}).waitFor({state:'visible'});assert.equal(await page.getByRole('button',{name:'Call',exact:true}).count(),1,'previously called requested lead keeps Call');
    leads.push({requestId:2,leadId:12,leadType:9,name:'Newly requested old lead',phone:'9876543212'});
    await page.evaluate(()=>{document.getElementById('rows').insertAdjacentHTML('beforeend','<tr><td>Newly requested</td><td><button class="btnPickup" id="12" mobile="9876543212">Pickup</button></td></tr>');window.HansCalling.refresh();});
    await page.waitForFunction(()=>document.querySelectorAll('[data-hans-request]').length===2);
    const shots=path.resolve(__dirname,'../../.local/crm-ui');fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'requested-call-buttons.png')});
    leads=leads.slice(0,1);await boot();await page.evaluate(()=>window.denyMic=true);await page.getByRole('button',{name:'Call',exact:true}).click();
    await page.getByText('Microphone blocked. Allow it for CRM and try again.',{exact:true}).waitFor();assert.equal(writes.filter(w=>w.p.endsWith('/audio') || w.p.endsWith('/call')).length,0,'denied mic must never dial');
    await boot();holdAudio=true;await page.getByRole('button',{name:'Call',exact:true}).click();
    while(!writes.some(w=>w.p.endsWith('/audio')))await page.waitForTimeout(30);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForTimeout(1700);
    assert.equal(writes.filter(w=>w.p.endsWith('/call')).length,0,'cancel during delayed audio response must not call customer');
    assert.ok(writes.some(w=>w.p.endsWith('/stop')),'delayed audio is stopped');assert.deepEqual(errors,[]);
    console.log('PASS: native CRM widget buttons, no automatic mic, Fresh exclusion, re-requested rows, audio gating, double-click, mute, redial availability, denied mic and cancellation.');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
