import { q, transaction, withLock } from '../db/pool.js';
import { hangup } from '../plivo.js';
import { activeBurst, repUp } from '../state.js';
import { emitToUser, pokeAdmins } from '../io.js';

export const AUDIO_IDLE_SECONDS = 120;
const SWEEP_MS = 10_000;

// Use provider call rows, not browser timers or mouse activity. Outcome editing and
// queue browsing do not need a paid connection. Ringing, held and bridged calls do.
export async function disconnectIdleAudio() {
  const { rows } = await q(`SELECT r.id, r.state->>'userId' AS user_id FROM plivo_calls r
    LEFT JOIN users u ON u.telnyx_session_call_id = r.id
    WHERE r.state->>'kind' = 'rep' AND r.ended_at IS NULL
      AND ((u.audio_mode = 'browser') OR r.idle_disconnect_at IS NOT NULL)`);
  for (const row of rows) {
    try {
      await withLock('idle-audio:' + row.id, async () => {
        const userId = Number(row.user_id);
        const claimed = await transaction(async () => {
          // Serializes with dial reservation, incoming call reservation and reconnect.
          const { rows: [u] } = await q('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
          const { rows: [r] } = await q('SELECT * FROM plivo_calls WHERE id = $1', [row.id]);
          if (!r || r.ended_at) return false;
          if (r.idle_disconnect_at) return true; // retry even if the rep has since reconnected
          if (u?.audio_mode !== 'browser' || u.telnyx_session_call_id !== r.id || activeBurst.get(userId) === 0) return false;
          const { rows: [state] } = await q(`SELECT
            EXISTS (SELECT 1 FROM plivo_calls c WHERE c.state->>'userId' = $1
              AND c.state->>'kind' IN ('lead', 'inbound') AND c.ended_at IS NULL) AS live,
            EXISTS (SELECT 1 FROM calls c JOIN bursts b ON b.id = c.burst_id
              WHERE b.user_id = $2 AND c.disposition IS NULL AND c.duration IS NULL) AS pending,
            greatest($3::timestamptz, $4::timestamptz,
              (SELECT max(c.ended_at) FROM plivo_calls c WHERE c.state->>'userId' = $1
                AND c.state->>'kind' IN ('lead', 'inbound')))
              <= now() - ($5 * interval '1 second') AS expired`,
          [String(userId), userId, r.created_at, u.audio_activity_at, AUDIO_IDLE_SECONDS]);
          if (state.live || state.pending || !state.expired) return false;
          // Refuse new calls before sending the hangup. Keep the session id for retries.
          await q('UPDATE users SET rep_connected = false WHERE id = $1', [userId]);
          await q('UPDATE plivo_calls SET idle_disconnect_at = now(), cancelled = true WHERE id = $1', [r.id]);
          return true;
        });
        if (!claimed) return;
        await hangup(row.id); // a failed DELETE is retried on the next sweep, including after restart
        const { rowCount } = await q(`UPDATE users SET rep_connected = false, telnyx_session_call_id = NULL
          WHERE id = $1 AND telnyx_session_call_id = $2`, [userId, row.id]);
        if (rowCount) {
          repUp.delete(userId);
          emitToUser(userId, 'rep:disconnected', { cause: 'idle_timeout' });
          pokeAdmins('live');
        }
      });
    } catch (error) { console.warn('idle audio disconnect:', row.id, error.message); }
  }
}

let timer;
let running = false;
export function startAudioIdleWorker() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await disconnectIdleAudio(); }
    catch (error) { console.warn('idle audio worker:', error.message); }
    finally { running = false; }
  };
  timer = setInterval(tick, SWEEP_MS);
  timer.unref?.();
  void tick();
}
