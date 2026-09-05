import 'dotenv/config';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { setIo } from './io.js';
import { router as auth, userIdFromCookieHeader } from './auth.js';
import { router as leads } from './routes/leads.js';
import { router as session } from './routes/session.js';
import { router as webhooks } from './routes/webhooks.js';

const app = express();
const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:3000';

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/webhooks', webhooks); // raw body, so it goes before express.json()
app.use('/static', express.static(fileURLToPath(new URL('../public/', import.meta.url))));

app.use((req, res, next) => { // CORS for the Next.js client on another port/origin
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(cookieParser());
app.use('/api', auth);
app.use('/api/leads', leads);
app.use('/api/session', session);
// Production: serve the Next.js static export (client/out) from here so browser and API share
// one origin - no CORS, no cross-site cookies. In dev the Next server runs on :3000 instead.
const clientOut = fileURLToPath(new URL('../../client/out/', import.meta.url));
if (existsSync(clientOut)) {
  app.use(express.static(clientOut));
  app.get('/{*splat}', (_req, res) => res.sendFile(join(clientOut, 'index.html')));
}
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin, credentials: true } });
io.use((socket, next) => {
  const uid = userIdFromCookieHeader(socket.handshake.headers.cookie);
  if (!uid) return next(new Error('unauthorized'));
  socket.data.userId = uid;
  next();
});
io.on('connection', (s) => s.join(`user:${s.data.userId}`));
setIo(io);

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () =>
  console.log(`dialer server on :${port}  webhooks -> ${process.env.PUBLIC_URL || '(PUBLIC_URL unset)'}/webhooks/telnyx`));
