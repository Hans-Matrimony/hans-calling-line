/* Native CRM calling: microphone access belongs to the host CRM document. */
(() => {
  'use strict';
  if (window.HansCalling) return;
  const config = window.HansCallingConfig;
  if (!config) return;
  const owner = crypto.randomUUID();
  let leads=[],client=null,sessionId=null,audioUp=false,activeUUID=null,busy=false,muted=false,generation=0,poll=null,refreshing=false;
  let sdkPromise=null, stopped=false, settingUp=false;
  const notice=document.getElementById('hans-calling-notice');
  const panel=document.createElement('section');
  panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Lead calling');panel.hidden=true;
  panel.style.cssText='position:fixed;right:20px;bottom:20px;z-index:1060;background:white;color:#172033;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 10px 35px #0003;padding:22px;width:340px;max-width:calc(100vw - 40px);font:14px/1.5 system-ui';
  panel.innerHTML='<strong>Hans Calling</strong><div data-name style="margin-top:12px;font-size:18px"></div><div data-phone></div><p data-status role="status" aria-live="polite"></p><button type="button" data-mute disabled>Mute</button> <button type="button" data-stop>Cancel</button> <button type="button" data-close hidden>Close</button>';
  document.body.appendChild(panel);
  const status=message=>{panel.querySelector('[data-status]').textContent=message;};
  async function api(path,body,keepalive=false) {
    const response=await fetch(config.base+'/'+path,{method:body?'POST':'GET',credentials:'include',keepalive,
      headers:{Accept:'application/json',...(body?{'Content-Type':'application/json','X-CSRF-TOKEN':config.csrf || ''}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(35000)});
    let data;try{data=await response.json();}catch{throw new Error('Calling service is unavailable.');}
    if(!response.ok)throw new Error(data.error || data.message || 'Calling request failed.');
    return data;
  }
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function disconnect() {
    audioUp=false;activeUUID=null;muted=false;
    if(client){client.removeAllListeners();try{client.hangup();}catch{}try{client.logout();}catch{}client=null;}
    panel.querySelector('[data-mute]').disabled=true;panel.querySelector('[data-mute]').textContent='Mute';
  }
  function check(current) {if(current!==generation)throw new Error('Call cancelled.');}
  async function sdk() {
    if(window.Plivo)return;
    if(!sdkPromise)sdkPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=config.sdk;script.onload=resolve;script.onerror=()=>reject(new Error('Could not load browser audio.'));document.head.appendChild(script);
    }).catch(e=>{sdkPromise=null;throw e;});
    await sdkPromise;
  }
  async function connect(current) {
    status('Allow microphone access to connect audio...');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Audio needs HTTPS and a microphone.');
    const probe=navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());});
    let timeout;
    try {await Promise.race([probe,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Microphone permission timed out.')),30000);})]);}
    finally{clearTimeout(timeout);}
    check(current);
    const [credentials]=await Promise.all([api('credentials',{owner}),sdk()]);check(current);
    const Constructor=window.Plivo.default || window.Plivo;
    client=new Constructor({debug:'ERROR',permOnClick:true,enableTracking:false,closeProtection:false}).client;
    client.setRingTone(false);client.setConnectTone(false);
    let logged=false,failed=null;
    client.on('onLogin',()=>{logged=true;});
    client.on('onLoginFailed',()=>{failed=new Error('Audio login failed.');});
    client.on('onMediaPermission',event=>{if(event.status==='failure')failed=new Error('Microphone permission denied.');});
    client.on('onConnectionChange',info=>{if(info.state==='disconnected'){audioUp=false;failed=new Error('Audio connection lost.');}});
    client.on('onIncomingCall',(_caller,_headers,info)=>{
      if(current!==generation || activeUUID){client?.reject(info.callUUID);return;}
      activeUUID=info.callUUID;if(!client.answer(info.callUUID,'reject'))failed=new Error('Could not connect audio.');
    });
    client.on('onCallAnswered',info=>{if(info?.callUUID===activeUUID)audioUp=true;});
    const ended=info=>{if(info?.callUUID===activeUUID){audioUp=false;activeUUID=null;}};
    client.on('onCallTerminated',(_cause,info)=>ended(info));client.on('onIncomingCallCanceled',ended);
    client.on('onCallFailed',(_cause,info)=>ended(info));
    if(!client.loginWithAccessToken(credentials.token))throw new Error('Audio login was rejected.');
    const loginDeadline=Date.now()+20000;
    while(!logged){check(current);if(failed)throw failed;if(Date.now()>loginDeadline)throw new Error('Audio login timed out.');await sleep(150);}
    check(current);status('Connecting audio...');
    const audio=await api('audio',{owner});
    if(current!==generation){await api('stop',{sessionId:audio.id,owner});check(current);}
    sessionId=audio.id;
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      check(current);if(failed)throw failed;
      const state=await api('state');check(current);
      if(state.session?.id!==sessionId || state.session?.ended_at || state.session?.stop_requested)throw new Error('Audio session ended. Try again.');
      if(audioUp && state.session.status==='ready'){panel.querySelector('[data-mute]').disabled=false;return;}
      await sleep(600);
    }
    throw new Error('Audio connection timed out.');
  }
  async function stop(message='Call ended.') {
    generation++;clearTimeout(poll);disconnect();
    panel.querySelector('[data-stop]').disabled=true;
    try {
      // Also recover an audio request whose HTTP response was lost.
      if(!sessionId){const state=await api('state');if(state.session?.owner_token===owner && !state.session.ended_at)sessionId=state.session.id;}
      if(sessionId)await api('stop',{sessionId,owner});
      sessionId=null;busy=settingUp;status(message);panel.querySelector('[data-close]').hidden=false;
    }catch(error){status(error.message+' Use End call again to retry.');}
    finally{panel.querySelector('[data-stop]').disabled=false;panel.querySelector('[data-stop]').textContent='End call';}
  }
  async function call(lead) {
    if(busy){panel.hidden=false;status('A call or audio setup is already in progress.');return;}
    busy=true;settingUp=true;stopped=false;const current=++generation;
    panel.hidden=false;panel.querySelector('[data-close]').hidden=true;panel.querySelector('[data-stop]').textContent='Cancel';
    panel.querySelector('[data-name]').textContent=lead.name || 'Requested lead';panel.querySelector('[data-phone]').textContent=lead.phone || '';
    try {
      await connect(current);check(current);
      status('Audio connected. Calling lead...');
      const row=await api('call',{owner,sessionId,requestId:lead.requestId,key:crypto.randomUUID()});check(current);
      panel.querySelector('[data-stop]').textContent='End call';
      async function monitor(){
        try {
          check(current);const state=await api('state');check(current);
          if(state.call?.id===row.id){
            if(state.call.ended_at){await stop('Call ended: '+(state.call.hangup_cause || state.call.status));return;}
            if(state.call.answered_at){const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(state.call.answered_at.replace(' ','T')+'Z'))/1000));status('Connected - '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'));}
            else status(state.call.status==='uncertain'?'Checking provider call status...':'Calling lead...');
          }
          if(!audioUp || state.session?.ended_at){await stop('Audio disconnected.');return;}
        }catch(error){if(current!==generation)return;status(error.message+' Checking status...');}
        poll=setTimeout(monitor,1500);
      }
      settingUp=false;monitor();
    }catch(error){settingUp=false;if(current===generation)await stop(error.name==='NotAllowedError'?'Microphone blocked. Allow it for CRM and try again.':error.message);else if(!sessionId)busy=false;}
  }
  panel.querySelector('[data-stop]').onclick=()=>stop('Call cancelled.');
  panel.querySelector('[data-close]').onclick=()=>{if(!busy)panel.hidden=true;};
  panel.querySelector('[data-mute]').onclick=()=>{if(!client || !audioUp)return;muted=!muted;if(muted)client.mute();else client.unmute();panel.querySelector('[data-mute]').textContent=muted?'Unmute':'Mute';};
  const phone=value=>{let digits=String(value || '').replace(/\D/g,'');if(digits.length===10)digits='91'+digits;return digits.replace(/^00/,'');};
  function attach() {
    document.querySelectorAll('[data-hans-request]').forEach(button=>{
      if(!leads.some(l=>String(l.requestId)===button.dataset.hansRequest))button.remove();
    });
    document.querySelectorAll('tr .btnPickup, tr .add_next_followup').forEach(pick=>{
      const row=pick.closest('tr');if(!row || row.querySelector('[data-hans-request]'))return;
      const candidates=leads.filter(l=>String(l.leadId)===pick.id && (!pick.getAttribute('mobile') || phone(l.phone)===phone(pick.getAttribute('mobile'))));
      if(candidates.length)addButton(pick.parentElement,candidates[0]);
    });
    const types={requestedFbLeads:1,requestedWebLeads:0,requestedExhaustLeads:3,requestedHighIncomeLeads:6,requestedOldLeads:5};
    Object.entries(types).forEach(([id,type])=>document.querySelectorAll('#'+id+' tbody tr').forEach(row=>{
      if(row.querySelector('[data-hans-request]'))return;
      const lead=leads.find(l=>l.leadType===type && phone(l.phone)===phone(row.cells[0]?.textContent));
      if(lead && row.cells[0])addButton(row.cells[0],lead);
    }));
  }
  function addButton(parent,lead){
    const button=document.createElement('button');button.type='button';button.className='btn btn-sm btn-primary';button.style.marginLeft='6px';
    button.dataset.hansRequest=String(lead.requestId);button.textContent='Call';button.onclick=event=>{event.preventDefault();event.stopPropagation();call(lead);};parent.appendChild(button);
  }
  async function refresh(){
    if(refreshing || stopped)return;refreshing=true;
    try{const data=await api('leads');leads=data.leads || [];attach();if(data.enabled===false && !busy)panel.hidden=true;if(notice)notice.textContent='';}
    catch(error){if(notice)notice.textContent=error.message;}
    finally{refreshing=false;}
  }
  let attachTimer;
  const observer=new MutationObserver(records=>{
    if(records.every(record=>panel.contains(record.target) || record.target===notice))return;
    clearTimeout(attachTimer);attachTimer=setTimeout(attach,50);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  if(window.jQuery)window.jQuery(document).ajaxComplete((_event,_xhr,settings)=>{if(!String(settings.url).includes('/calling/'))refresh();});
  refresh();const refreshTimer=setInterval(refresh,15000);
  window.addEventListener('pagehide',()=>{
    stopped=true;generation++;clearInterval(refreshTimer);clearTimeout(poll);observer.disconnect();disconnect();
    if(sessionId)api('stop',{sessionId,owner},true).catch(()=>{});
  });
  window.HansCalling={call,refresh};
})();
