import { createHash } from 'node:crypto';
import { q, withLock } from '../db/pool.js';

export async function storeEvent(event) {
  const data = event?.data ?? event;
  const json = JSON.stringify(event);
  const id = String(data.id ?? createHash('sha256').update(json).digest('hex'));
  await q('INSERT INTO telnyx_events(id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, json]);
  return id;
}

export async function processEvent(id, handle) {
  return withLock('telnyx-event:' + id, async () => {
    const { rows: [row] } = await q('SELECT event FROM telnyx_events WHERE id = $1 AND processed_at IS NULL', [id]);
    if (!row) return;
    try {
      await handle(row.event);
      await q('UPDATE telnyx_events SET processed_at = now(), error = NULL WHERE id = $1', [id]);
    } catch (e) {
      await q(`UPDATE telnyx_events SET attempts = attempts + 1, error = $2,
        next_attempt_at = now() + LEAST(300, power(2, LEAST(attempts, 8))) * interval '1 second' WHERE id = $1`,
      [id, String(e.message).slice(0, 500)]);
      console.warn('webhook deferred', id, e.message);
    }
  });
}

export function startEventWorker(handle) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await q(`SELECT id FROM telnyx_events WHERE processed_at IS NULL AND next_attempt_at <= now()
        ORDER BY received_at LIMIT 50`);
      for (const row of rows) await processEvent(row.id, handle);
      await q("DELETE FROM telnyx_events WHERE processed_at < now() - interval '7 days'");
    } catch (e) { console.warn('webhook worker', e.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return timer;
}
