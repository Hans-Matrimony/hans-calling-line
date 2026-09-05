// Generates public/beep.wav: 1 kHz sine, 300 ms, 8 kHz 16-bit mono PCM.
// Played into the rep ear right before bridging (plan s8, detail #1).
import { writeFileSync, mkdirSync } from 'node:fs';

const rate = 8000, ms = 300, freq = 1000, n = Math.round((rate * ms) / 1000);
const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const env = Math.min(1, i / 80, (n - i) / 80); // 10 ms fade in/out to avoid a click
  data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.6 * 32767 * env), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);

mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/beep.wav', import.meta.url), Buffer.concat([h, data]));
console.log('wrote public/beep.wav', 44 + data.length, 'bytes');
