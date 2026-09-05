import { resolveLead, segmentFor, COUNTRIES, DIAL_CODES } from '../src/lib/countries.js';
const cases = [
  ['India',                '+1 415 555 0100'],  // Indian lead with US number -> must be india
  ['United States',        '+1 212 555 0100'],
  ['UAE',                  '+971 50 123 4567'],
  ['  united  KINGDOM ',   '+44 20 7946 0000'],
  ['',                     '+971501234567'],    // blank country -> dial code
  ['',                     '00447911123456'],   // 00 prefix
  ['Atlantis',             '+65 6123 4567'],    // unknown country -> dial code
  ['Atlantis',             '12345'],            // nothing resolves -> null
  ['',                     '9876543210'],       // bare local number, no country -> null, NOT Iran
  ['',                     '+919876543210'],    // same number with prefix -> india
];
for (const [country, phone] of cases) {
  const r = resolveLead({ country, phone });
  console.log(JSON.stringify(country).padEnd(22), phone.padEnd(18), '->',
    r ? JSON.stringify({ ...r, segment: segmentFor(r.region) }) : 'null');
}
console.log('rows: countries', COUNTRIES.size, '| dial codes', DIAL_CODES.size);
