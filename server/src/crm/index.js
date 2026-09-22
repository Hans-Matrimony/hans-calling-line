import { createStore } from './store.js';
import { createCrmApp } from './app.js';
const store=createStore();
const {app,service}=createCrmApp(store);
await store.query('SELECT id FROM hans_calling_sessions LIMIT 1');
const server=app.listen(Number(process.env.PORT || 3001),()=>console.log('Hans calling: CRM MySQL mode'));
const timer=setInterval(()=>service.sweep().catch(e=>console.error('[crm-worker]',e.code || e.name)),10000);
timer.unref();
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  clearInterval(timer); server.close(()=>store.close().then(()=>process.exit(0)));
});
