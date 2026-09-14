// Always start an isolated in-memory Postgres-compatible database; never read server/.env.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let exitCode = 0;
for (const file of process.argv.slice(2).length ? process.argv.slice(2) : ['cascade-test.mjs', 'hubspot-test.mjs', 'admin-test.mjs', 'reliability-test.mjs']) {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 25 });
  await server.start();
  const connection = server.getServerConn();
  const env = { ...process.env, DATABASE_URL: connection.startsWith('postgres') ? connection : 'postgresql://postgres:postgres@' + connection + '/postgres',
    HUBSPOT_TOKEN: '', TELNYX_API_KEY: '', EAZYBE_TEST_DATABASE: 'isolated', DOTENV_CONFIG_PATH: fileURLToPath(new URL('./.no-test-env', import.meta.url)),
    RECORD_CALLS: 'false', SESSION_SECRET: 'isolated-test-secret', FROM_NUMBER_US: '+12025550100',
    FROM_NUMBER_INDIA: '+919810000000', FROM_NUMBER_EU: '+442079460000' };
  try {
    console.log('\nRunning ' + file + ' on the disposable local database');
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL(file, import.meta.url))],
      { env, stdio: 'inherit', cwd: fileURLToPath(new URL('../../', import.meta.url)) });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (code) exitCode = 1;
  } finally { await server.stop(); await db.close(); }
}
process.exitCode = exitCode;
