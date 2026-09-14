/* Browser regression tests for the production page, components and useDialer hook.
 * Only the audio driver, Socket.IO transport and HTTP responses are replaced.
 * No .env files are loaded; every non-loopback browser request is blocked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const F = require('./fixtures.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.ui-test');
const shots = path.resolve(root, '../docs/ui-implementation');
const w = require('next/dist/compiled/webpack/webpack'); w.init();
const bundled = process.env.CODEX_NODE_MODULES || path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(bundled, 'playwright')); }
const checks = [];
const check = (name, condition = true) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const html = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/admin.css"><link rel="stylesheet" href="/workspace.css"><style>:root{--font-hanken:"Hanken Grotesk";--font-saira:"Saira Semi Condensed";--font-plex-mono:"IBM Plex Mono"}</style><title>Eazybe UI test</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
async function bundle() {
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(shots, { recursive: true });
  const compiler = w.webpack({ mode: 'development', devtool: false, entry: path.join(__dirname, 'entry.cjs'), output: { path: out, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js', '.cjs'], modules: [path.join(root, 'node_modules'), 'node_modules'], alias: { 'socket.io-client': path.join(__dirname, 'socket.cjs') } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(__dirname, 'ts-loader.cjs') }] },
    plugins: [new w.webpack.DefinePlugin({ 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('') }), new w.webpack.NormalModuleReplacementPlugin(/\/useSoftphone$/, path.join(__dirname, 'audio.cjs'))],
  });
  await new Promise((resolve, reject) => compiler.run((err, stats) => compiler.close(() => err ? reject(err) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve())));
}
async function main() {
  await bundle();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = p === '/bundle.js' ? path.join(out, 'bundle.js') : ['/globals.css', '/admin.css', '/workspace.css'].includes(p) ? path.join(root, 'app', p.slice(1))
      : p === '/fonts.css' ? path.resolve(root, '../docs/ui-proposal/fonts.css') : /^\/fonts\/[a-z0-9.\-]+\.woff2$/.test(p) ? path.resolve(root, '../docs/ui-proposal', p.slice(1)) : null;
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', p.endsWith('.css') ? 'text/css; charset=utf-8' : p.endsWith('.woff2') ? 'font/woff2' : 'application/javascript; charset=utf-8'); fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      const params = new URLSearchParams(location.search);
      if (sessionStorage.getItem('test-case') !== params.get('case')) {
        sessionStorage.clear(); localStorage.clear();
        sessionStorage.setItem('test-case', params.get('case'));
        localStorage.setItem('eazybe.tab', params.get('tab') || 'auto');
      }
    });
    const errors = []; const blocked = []; const unknown = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let state; let writes;
    const emit = (name, value) => page.evaluate(([n, v]) => window.testSocket(n, v), [name, value]);
    const liveCard = () => state.card;
    await page.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
      if (url.hostname !== '127.0.0.1') { blocked.push(url.hostname); await route.abort(); return; }
      if (!p.startsWith('/api/')) { await route.continue(); return; }
      const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.method() === 'GET') {
        if (state.role === 'admin' && F.admin[p]) return reply(F.admin[p]);
        if (p === '/api/me') return reply({ ...F.me, role: state.role });
        if (p === '/api/session/state') return reply({ repUp: state.audio, phase: state.phase, legs: state.phase === 'idle' ? [] : [{ ...F.legs[0], card: liveCard(), status: state.phase === 'ringing' ? 'ringing' : 'answered' }], card: ['live', 'ended'].includes(state.phase) ? liveCard() : null, answeredAt: F.ago(2), duration: state.phase === 'ended' ? 151 : null });
        if (p === '/api/leads/stats') return reply({ ...F.stats, ready: state.empty ? 0 : 6, hubspot: state.syncError ? { ...F.stats.hubspot, ok: false, error: 'HubSpot scope unavailable' } : F.stats.hubspot });
        if (p === '/api/session/from-numbers') return reply(state.capped ? [{ ...F.from[0], usedToday: 100, available: false }] : F.from);
        if (p === '/api/leads/next') return state.queueError ? reply({ error: 'Queue unavailable' }, 503) : reply(state.empty ? [] : state.leads);
        if (p === '/api/leads/queue') return reply(state.empty ? { ...F.queue, total: 0, ready: { ...F.queue.ready, count: 0, leads: [] }, later: [], soonest: null } : F.queue);
        if (p === '/api/leads/activity') return reply([{ callId: 100, name: 'Emma Wilson', phone: '+442079461234', country: 'United Kingdom', from: F.from[0].number, startedAt: F.ago(15), answered: true, duration: 90, disposition: 'connected', subOutcome: 'interested', notes: 'Demo requested', burstWon: true }]);
        if (/\/history$/.test(p)) return state.historyError ? reply({ error: 'History unavailable' }, 503) : reply([{ callId: 98, at: F.ago(1440), answered: false, duration: 0, disposition: 'no_answer', notes: 'Try again this week' }]);
      } else {
        const body = req.postDataJSON?.() || {};
        writes.push({ path: p, body });
        if (p === '/api/session/webrtc-token') return reply({ token: 'fixture-only' });
        if (p === '/api/session/connect') return reply({});
        if (p === '/api/session/disposition') {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (state.failSave) return reply({ error: 'Temporary save failure' }, 503);
          state.phase = 'idle'; state.leads = state.leads.filter((l) => l.id !== liveCard().leadId);
          return reply({ status: body.subOutcome === 'callback' ? 'queued' : 'done', retryMinutes: null, nextCallAt: body.laterAt || null });
        }
        if (/^\/api\/leads\/\d+$/.test(p)) {
          if (state.failContact) return reply({ error: 'Contact update failed' }, 503);
          state.card = { ...state.card, name: body.name, phones: body.phones, extra: { ...state.card.extra, ...body } };
          state.leads = state.leads.map((l) => l.id === liveCard().leadId ? { ...l, name: body.name, extra: state.card.extra, phones: body.phones } : l);
          return reply({ name: body.name, extra: state.card.extra, phones: body.phones, phoneIdx: 1 });
        }
        if (p === '/api/session/burst' || p === '/api/session/dial') {
          const l = state.leads[0] || F.leads[0];
          state.card = { ...F.card, callId: liveCard().callId + 1, leadId: l.id, name: l.name, extra: l.extra, phone: l.phone };
          state.phase = 'ringing';
          const legs = Array.from({ length: body.legs || 1 }, (_, i) => ({ ...F.legs[0], leadId: l.id + i, name: i ? F.leads[1].name : l.name, phone: i ? F.leads[1].phone : l.phone, card: { ...state.card, leadId: l.id + i } }));
          await reply({}); return emit('burst:started', { legs, manual: p.endsWith('/dial') });
        }
        if (p === '/api/session/hangup-lead') { state.phase = 'ended'; await reply({}); return emit('call:ended', { callId: liveCard().callId, duration: 151, cause: 'rep_hangup' }); }
        if (p === '/api/session/dtmf') return reply({});
        if (p === '/api/leads/sync') return reply({ added: 0, resumed: 0, reopened: 0, removed: 0, skipped: 0, ticked: 0, syncedAt: new Date().toISOString() });
      }
      unknown.push(p); return reply({ error: 'Unmocked test endpoint: ' + p }, 500);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    let caseId = 0;
    const load = async (phase = 'live', tab = 'auto', options = {}) => {
      state = { phase, role: 'rep', audio: true, card: structuredClone(F.card), leads: structuredClone(F.leads), ...options }; writes = [];
      await page.goto(url + '?case=' + (++caseId) + '&tab=' + tab);
      await page.locator(state.role === 'admin' ? '.ad-screen' : '.cw-conversation').waitFor();
      if (phase === 'live') await page.getByRole('button', { name: 'Hang up', exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
    };
    const screenshot = (name) => page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true });
    const dispositionWrites = () => writes.filter((w) => w.path.endsWith('/disposition'));
    const dialWrites = () => writes.filter((w) => w.path.endsWith('/burst') || w.path.endsWith('/dial'));

    await load();
    await page.locator('#call-note').fill('Interested in a demo for their team of 12. Discuss HubSpot follow-ups and WhatsApp handoffs.');
    await screenshot('live-desktop');
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    check('Mute toggles through the audio hook', await page.getByRole('button', { name: 'Unmute', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: 'Keypad', exact: true }).click();
    await page.getByRole('button', { name: 'Send 5', exact: true }).click();
    check('Keypad sends one DTMF request', writes.filter((w) => w.path.endsWith('/dtmf') && w.body.digits === '5').length === 1);
    await page.getByRole('button', { name: 'Hang up', exact: true }).click();
    await page.getByRole('button', { name: 'Save outcome', exact: true }).waitFor();
    check('Save disabled until an outcome is selected', await page.getByRole('button', { name: 'Save outcome', exact: true }).isDisabled());
    check('Notes survive hangup', (await page.locator('#call-note').inputValue()).includes('team of 12'));
    await page.reload();
    await page.locator('#call-note').waitFor();
    check('Notes and ended call survive reload', (await page.locator('#call-note').inputValue()).includes('team of 12'));
    await page.keyboard.press('1');
    check('Outcome shortcut selects without saving', dispositionWrites().length === 0 && await page.getByRole('button', { name: 'Interested 1', exact: true }).getAttribute('aria-pressed') === 'true');
    state.failSave = true;
    await page.getByRole('button', { name: 'Save outcome', exact: true }).click();
    check('Save locks during the request', await page.getByRole('button', { name: 'Saving outcome…', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Retry save outcome', exact: true }).waitFor();
    check('Failed save retains notes and has no Next action', (await page.locator('#call-note').inputValue()).includes('team of 12') && await page.getByRole('button', { name: 'Next lead', exact: true }).count() === 0);
    state.failSave = false;
    await screenshot('outcome-desktop');
    await page.getByRole('button', { name: 'Retry save outcome', exact: true }).click();
    await page.locator('.cw-saved').waitFor();
    check('Saved confirmation keeps the completed lead visible', (await page.locator('.cw-person-name h2').textContent()) === 'Maya Patel');
    check('Save never starts the next call', dialWrites().length === 0);
    check('Saved draft is removed from tab storage', await page.evaluate(() => !sessionStorage.getItem('eazybe.note.1.101')));
    await screenshot('saved-desktop');
    await page.getByRole('button', { name: 'Next lead', exact: true }).click();
    await page.locator('.cw-ringing').waitFor();
    check('Next lead explicitly starts one auto dial', dialWrites().length === 1 && dialWrites()[0].body.legs === 1);

    await load('ended');
    for (const name of ['Interested 1', 'Follow-up required 2', 'Callback requested 3', 'Not interested 4', 'Not qualified 5', 'No answer 6', 'Wrong number 7']) {
      await page.getByRole('button', { name, exact: true }).click();
    }
    check('All seven outcome tiles select without writing', dispositionWrites().length === 0);
    await page.getByRole('button', { name: 'Not interested 4', exact: true }).click();
    await page.getByRole('button', { name: 'Price', exact: true }).click();
    check('Optional reason selection also waits for Save', dispositionWrites().length === 0);
    await page.getByRole('button', { name: 'Callback requested 3', exact: true }).click();
    check('Callback requires a date', await page.getByRole('button', { name: 'Save outcome', exact: true }).isDisabled());
    await page.locator('#callback-time').fill('2020-01-01T10:00');
    check('Past callback date is rejected', await page.getByRole('button', { name: 'Save outcome', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Tomorrow, 10am there', exact: true }).click();
    check('Callback preset does not save immediately', dispositionWrites().length === 0);
    await page.getByRole('button', { name: 'Save outcome', exact: true }).click();
    await page.locator('.cw-saved').waitFor();
    check('Callback writes a future timestamp and selected sub-outcome', dispositionWrites()[0].body.subOutcome === 'callback' && new Date(dispositionWrites()[0].body.laterAt) > new Date());

    await load('idle');
    await screenshot('ready-desktop');
    await page.getByRole('searchbox').fill('Oliver');
    check('Queue preview search filters the visible contacts', await page.locator('.cw-queue-list li').count() === 1);
    await page.locator('.cw-queue-list button').click();
    check('Inspecting a lead does not change the next dial silently', await page.getByRole('button', { name: 'Review next lead', exact: true }).isVisible() && dialWrites().length === 0);
    await page.getByRole('button', { name: 'Review next lead', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Company', exact: true }).fill('Northstar Updated');
    state.failContact = true;
    await page.getByRole('button', { name: 'Save contact', exact: true }).click();
    await page.getByText('Couldn’t save:', { exact: false }).waitFor();
    check('Failed contact save retains draft without changing displayed identity', !(await page.locator('.cw-person-name p').textContent()).includes('Updated') && await page.getByRole('textbox', { name: 'Company', exact: true }).inputValue() === 'Northstar Updated');
    state.failContact = false;
    await page.getByRole('button', { name: 'Save contact', exact: true }).click();
    await page.getByText('Contact saved', { exact: true }).waitFor();
    check('Confirmed contact save updates identity', (await page.locator('.cw-person-name p').textContent()).includes('Updated'));

    await load('idle', 'burst');
    await page.getByRole('button', { name: 'Start calling', exact: true }).click();
    await page.locator('.cw-ringing').waitFor();
    check('Burst starts two legs', dialWrites()[0].body.legs === 2 && await page.locator('.cw-ringing > div').count() === 2);
    await screenshot('burst-desktop');
    await page.getByRole('button', { name: 'End after this call', exact: true }).click();
    await emit('burst:ended', { result: 'no_answer', legs: [{ leadId: 1, name: 'Maya Patel', phone: F.card.phone, disposition: 'no_answer' }] });
    await page.getByText('Last run', { exact: true }).waitFor();
    check('End after this call also ends an unanswered burst');

    await load('idle', 'dialer', { capped: true });
    await page.getByRole('textbox', { name: 'Number to call', exact: true }).fill('+442079460001');
    check('Manual call disabled when all caller IDs are capped', await page.getByRole('button', { name: 'Call', exact: true }).isDisabled());
    await load('idle', 'dialer');
    await page.getByRole('textbox', { name: 'Number to call', exact: true }).fill('+442079460001');
    await page.getByRole('button', { name: 'Call', exact: true }).click();
    await page.locator('.cw-ringing').waitFor();
    check('Manual dial preserves the pasted international number and caller ID', dialWrites()[0].body.to === '+442079460001' && dialWrites()[0].body.from === F.from[0].number);
    await load('idle', 'auto', { queueError: true });
    await page.getByRole('button', { name: 'Retry loading', exact: true }).waitFor();
    check('Queue fetch failure provides a retry action', await page.getByRole('button', { name: 'Start calling', exact: true }).isDisabled());
    state.queueError = false;
    await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
    await page.locator('.cw-queue-list button').first().waitFor();
    check('Retry restores the loaded queue');
    await load('idle', 'auto', { empty: true, syncError: true });
    check('Empty queue and sync failure are explicit', await page.getByRole('button', { name: 'Start calling', exact: true }).isDisabled() && await page.getByText('HubSpot needs attention', { exact: true }).isVisible());

    for (const phase of ['live', 'ended']) {
      await load(phase);
      for (const width of [1440, 1280, 960, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        check(`${phase} layout fits ${width}px`, size.scroll <= size.client);
        if (width === 390) {
          await screenshot(phase + '-mobile');
          check('Call panel comes before contact and queue on mobile', await page.evaluate(() => document.querySelector('.cw-conversation').getBoundingClientRect().top < document.querySelector('.cw-context').getBoundingClientRect().top && document.querySelector('.cw-context').getBoundingClientRect().top < document.querySelector('.cw-queue').getBoundingClientRect().top));
          check('Mobile navigation has five readable, separate targets', await page.locator('.rep-app .nav').evaluateAll((els) => els.every((el, i) => { const r = el.getBoundingClientRect(); return r.width >= 54 && r.height >= 44 && (!i || r.left >= els[i - 1].getBoundingClientRect().right); })));
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('Reduced motion removes lamp animation', await page.locator('.cw-call-state .lamp').evaluate((el) => getComputedStyle(el).animationName === 'none'));
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.keyboard.press('Tab');
    check('Keyboard focus has a visible indicator', await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'));
    for (const tab of ['Activity', 'Up next']) {
      await page.getByRole('button', { name: new RegExp('^' + tab) }).first().click();
      await page.locator('.cw-workspace > .panel').waitFor();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        check(`${tab} fits ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      }
      await screenshot(tab === 'Activity' ? 'activity-mobile' : 'queue-mobile');
    }
    await load('idle', 'auto', { role: 'admin' });
    for (const tab of ['Overview', 'Reps', 'Calls', 'Leads', 'Wallet', 'Users']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.locator('.ad-screen').waitFor();
      await page.waitForTimeout(120);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        check(`Admin ${tab} fits ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
        if (width === 1440 && tab === 'Overview') await screenshot('admin-desktop');
      }
    }
    check('No browser runtime errors', errors.length === 0);
    check('All API calls used test fixtures', unknown.length === 0);
    check('No external integrations were contacted', blocked.every((host) => host === 'flagcdn.com'));
    fs.writeFileSync(path.join(shots, 'validation.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, errors, unknownEndpoints: unknown, blockedHosts: [...new Set(blocked)], isolation: 'Actual production page, components and useDialer; test audio, socket transport and HTTP fixtures. No live calls or HubSpot writes.' }, null, 2) + '\n');
    console.log(`${checks.length} UI checks passed.`);
  } finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
