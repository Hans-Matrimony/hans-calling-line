// Persistent development database; production continues to use DATABASE_URL.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.local/postgres/', import.meta.url));
await mkdir(directory, { recursive: true });
const db = await PGlite.create(directory);
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 5433, maxConnections: 25 });
try {
  await server.start();
} catch (error) {
  await db.close();
  throw error;
}
console.log('Local development database listening on 127.0.0.1:5433');
console.log('Data directory: ' + directory);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await db.close();
}
process.once('SIGINT', () => stop().catch(console.error));
process.once('SIGTERM', () => stop().catch(console.error));
