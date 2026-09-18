// Boots the server against an unreachable DB and hits the wiring: health, auth gate, error
// handler, unsigned webhook rejection, static beep. No Plivo or Postgres needed.
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.PORT = '3999';
await import('../src/index.js');
await new Promise((r) => setTimeout(r, 400));
const B = 'http://127.0.0.1:3999';
const j = { 'content-type': 'application/json' };
console.log('health            ->', JSON.stringify(await (await fetch(B + '/health')).json()));
console.log('me (no cookie)    ->', (await fetch(B + '/api/me')).status, '(expect 401)');
const login = await fetch(B + '/api/login', { method: 'POST', headers: j, body: JSON.stringify({ email: 'x', password: 'y' }) });
console.log('login, DB down    ->', login.status, (await login.json()).error, '(expect 500 + pg error)');
console.log('unsigned webhook  ->', (await fetch(B + '/webhooks/plivo/answer', { method: 'POST', headers: j, body: '{}' })).status, '(expect 403)');
const beep = await fetch(B + '/static/beep.wav');
console.log('beep.wav          ->', beep.status, beep.headers.get('content-type'), beep.headers.get('content-length'), 'bytes', beep.headers.get('cache-control'), '(expect public, max-age=86400, immutable)');
const ui = await fetch(B + '/');
console.log('GET / (static UI) ->', ui.status, ui.headers.get('content-type'), '(expect 200 text/html once client/out exists)');
const deep = await fetch(B + '/anything');
console.log('GET /anything     ->', deep.status, '(expect 200, SPA fallback)');
process.exit(0);
