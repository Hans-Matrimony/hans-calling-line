// Generates the rep-leg cue sounds in server/public as 8 kHz 16-bit mono WAV (what telephony providers play best).
// Run from server/: node scripts/gen-sounds.mjs
// The server uploads these to Telnyx Media Storage on boot (telnyx.js ensureCues) and plays them by name,
// so after regenerating one, delete it there once (telnyx().media.delete(name)) or the old sound keeps playing.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATE = 8000;
const out = fileURLToPath(new URL('../public/', import.meta.url));

/** tone(hz, ms, amp) -> Float32Array with 5 ms fade in/out so it does not click. */
function tone(hz, ms, amp) {
  const n = Math.round(RATE * ms / 1000), fade = Math.round(RATE * 0.005), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    s[i] = amp * env * Math.sin(2 * Math.PI * hz * i / RATE);
  }
  return s;
}
const silence = (ms) => new Float32Array(Math.round(RATE * ms / 1000));
function concat(parts) {
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const sounds = {
  // Dialing in progress: one quiet tick every 2 s (looped. Low enough to keep writing notes.
  'tick.wav': concat([tone(900, 50, 0.18), silence(1950)]),
  // Lead answered, you are about to be bridged: rising two-tone, clearly different from the tick.
  'beep.wav': concat([tone(700, 140, 0.6), tone(1050, 160, 0.6)]),
  // Burst over, nobody picked up: low double beep.
  'noanswer.wav': concat([tone(420, 180, 0.5), silence(120), tone(420, 180, 0.5)]),
};
for (const [name, samples] of Object.entries(sounds)) {
  fs.writeFileSync(out + name, wav(samples));
  console.log(name, (samples.length / RATE).toFixed(2) + 's', fs.statSync(out + name).size + 'B');
}
