import 'dotenv/config';
if (process.env.CALLING_STORAGE === 'crm_mysql') await import('./crm/index.js');
else await import('./legacy-index.js');
