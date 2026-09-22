import 'dotenv/config';
if (process.env.CALLING_STORAGE === 'crm_mysql') {
  const { createStore } = await import('../crm/store.js');
  const store = createStore();
  try { await store.migrate(); console.log('CRM calling tables applied'); } finally { await store.close(); }
} else await import('./migrate-postgres.js');
