const now = new Date();
const ago = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
const future = (minutes) => new Date(now.getTime() + minutes * 60000).toISOString();
const me = { id: 1, email: 'alex@example.com', role: 'rep', phone: null };
const names = [['Maya Patel', 'Northstar Commerce', 'Revenue Operations Lead'], ['Oliver Grant', 'Brightline Studio', 'Founder'], ['Sophie Bennett', 'Evergreen Labs', 'Sales Director'], ['Alex Morgan', 'Fieldwork', 'Commercial Lead'], ['Priya Shah', 'Clearway', 'Growth Lead'], ['James Ellis', 'Harbor Partners', 'Head of Sales']];
const leads = names.map(([name, company, title], i) => ({ id: i + 1, name, phone: '+44207946000' + i, phones: ['+44207946000' + i], country: 'United Kingdom', segment: 'non_india', utc_offset: '1', timezone: 'Europe/London', attemptLimit: 6, attempt_count: i ? 0 : 2, status: 'queued', next_call_at: ago(1), last_outcome: i ? null : 'no_answer', lastCallAt: i ? null : ago(1440), everConnected: false, extra: { company, title, email: name.toLowerCase().replace(' ', '.') + '@example.com', leadStage: 'Demo requested', origin: 'HubSpot' }, phoneIdx: 1, phoneCount: 1 }));
const card = { callId: 101, leadId: 1, name: leads[0].name, phone: leads[0].phone, country: 'United Kingdom', segment: 'non_india', utcOffset: '1', timezone: 'Europe/London', attemptLimit: 6, hubspotId: '1234', extra: leads[0].extra, attempt: 3, lastOutcome: 'no_answer', lastNote: 'Asked to try again this week.', lastCallAt: ago(1440), everConnected: false, callCount: 2, phones: leads[0].phones, phoneIdx: 1 };
const from = [{ number: '+442079469999', region: 'eu', usedToday: 42, cap: 100, available: true }];
const legs = [{ leadId: 1, name: card.name, phone: card.phone, country: card.country, from: from[0].number, status: 'ringing', card }];
const stats = { dialed_today: 42, connected_today: 12, talk_seconds_today: 1820, queued: 18, ready: 6, waiting_gap: 5, waiting_window: 7, next_open_at: future(15), hubspot: { configured: true, ok: true, syncedAt: ago(2), inQueue: 18 } };
const group = (key, why, retryMinutes, count) => ({ key, why, retryMinutes, opensAt: future(retryMinutes || 60), count, countries: ['United Kingdom'], leads: [{ ...leads[1], id: 10 + (retryMinutes || 0), opensAt: future(retryMinutes || 60), why }] });
const queue = { now: now.toISOString(), total: 18, ready: { key: 'ready', why: null, opensAt: null, count: 6, countries: ['United Kingdom'], leads: leads.map((l) => ({ ...l, opensAt: ago(1), why: null })) }, later: [group('gap:10', 'gap', 10, 2), group('gap:15', 'gap', 15, 3), group('gap:120', 'gap', 120, 7)], soonest: future(10) };
const sum = { dials: 42, connects: 12, talk_secs: 1820, leads_dialed: 31, leads_reached: 11, abandoned: 0, callbacks: 3, wrap_median: 25, ni_dials: 30, ni_connects: 9, in_dials: 12, in_connects: 3, cancelled_legs: 2 };
const rep = { id: 1, email: me.email, active: true, hubspot_mapped: true, hubspot_synced_at: ago(2), dials: 42, connects: 12, talk_secs: 1820, wrap_median: 25, in_queue: 18, now: null, hubspot: 'mapped' };
const call = { id: 101, started_at: ago(10), rep_id: 1, rep: me.email, lead_id: 1, name: card.name, phone: card.phone, from_number: from[0].number, country: card.country, segment: 'non_india', hubspot_contact_id: null, ring_secs: 8, talk_secs: 151, disposition: 'connected', sub_outcome: 'interested', reason: null, notes: 'Requested a demo.', wrap_secs: 25, recording_status: null, recording_token: null, recording_secs: null, hubspot_call_id: null, hubspot_file_url: null, hubspot_error: null, cost: .17 };
const lead = { ...leads[0], source: 'hubspot', last_call_at: ago(10), hubspot_contact_id: null, company: card.extra.company, hubspot_url: null, rep_id: 1, rep: me.email };
const period = { from: ago(1440).slice(0, 10), to: now.toISOString().slice(0, 10), spend: 5.42, rep_spend: 2.12, lead_spend: 3.3, legs: 50, billed_secs: 2210, currency: 'USD', dials: 42, connects: 12, awaiting_cost: 0, parts: [] };
const admin = {
  '/api/admin/summary': { period: 'today', from: now.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), current: sum, previous: { ...sum, dials: 35, connects: 8 } },
  '/api/admin/by-day': Array.from({ length: 7 }, (_, i) => ({ day: ago((6 - i) * 1440).slice(0, 10), dials: 20 + i * 4, connects: 5 + i })),
  '/api/admin/outcomes': [{ outcome: 'interested', n: 8 }, { outcome: 'no_answer', n: 26 }, { outcome: 'callback', n: 3 }],
  '/api/admin/reps': [rep], '/api/admin/caller-ids': from, '/api/admin/live': [],
  '/api/admin/calls': { rows: [call], total: 1 }, '/api/admin/leads': { rows: [lead], total: 1 },
  '/api/admin/leads/1': { ...lead, extra: card.extra, attempts: [{ ...call, to_number: call.phone }] },
  '/api/admin/reps/1': { rep: { ...me, active: true }, current: sum, previous: sum, byHour: [], byCountry: [], queue: [], readiness: stats, hubspot: stats.hubspot, recent: [call], now: null },
  '/api/admin/wallet': { balance: { balance: 94.58, pending: 0, creditLimit: 0, availableCredit: 0, currency: 'USD', asOf: ago(1) }, periods: { today: period, d7: period, d30: period }, byDay: [] },
  '/api/admin/health': { recording: { on: true, beep: true, saved: 12, errors: 0 }, cost: { lastAt: ago(1), rows: 42 }, hubspot: { ...stats.hubspot, logged: 12, failed: 0 }, settings: { hubspot_create_contacts: false } },
  '/api/admin/users': [{ ...me, active: true, created_at: ago(14400), deactivated_at: null, hubspot_mapped: true, in_queue: 18, dials_7d: 100, audio: false }],
};
module.exports = { me, leads, card, from, legs, stats, queue, admin, ago, future };
