// Country / dial code -> IANA timezone and caller-ID region. Offsets follow the date.
// region  = which caller ID dials this lead:
//           india -> FROM_NUMBER_INDIA, eu -> FROM_NUMBER_EU, us -> FROM_NUMBER_US (APAC falls back to us)
//
// Timezone is derived from the HubSpot `country` property FIRST; the dial code is only the
// fallback for blank country. An Indian lead with a +1 number still resolves to India.

// IANA zones replace the historical offsets below. Countries with multiple zones retain the
// original representative location (US East, eastern Australia); actual DST rules apply by date.
const ZONES = [
  ['Asia/Kolkata', '91', 'india|in|bharat'],
  ['America/New_York', '1', 'united states|usa|us|united states of america|u.s.|u.s.a.'],
  ['America/Toronto', '', 'canada'], ['America/Mexico_City', '52', 'mexico'],
  ['America/Bogota', '57', 'colombia'], ['America/Lima', '51', 'peru'],
  ['America/Sao_Paulo', '55', 'brazil'], ['America/Argentina/Buenos_Aires', '54', 'argentina'],
  ['Europe/London', '44', 'united kingdom|uk|great britain|england|scotland|wales'],
  ['Europe/Dublin', '353', 'ireland'], ['Europe/Lisbon', '351', 'portugal'],
  ['Europe/Berlin', '49', 'germany'], ['Europe/Paris', '33', 'france'],
  ['Europe/Amsterdam', '31', 'netherlands'], ['Europe/Madrid', '34', 'spain'], ['Europe/Rome', '39', 'italy'],
  ['Europe/Brussels', '32', 'belgium'], ['Europe/Zurich', '41', 'switzerland'], ['Europe/Vienna', '43', 'austria'],
  ['Europe/Stockholm', '46', 'sweden'], ['Europe/Oslo', '47', 'norway'], ['Europe/Copenhagen', '45', 'denmark'],
  ['Europe/Warsaw', '48', 'poland'], ['Europe/Prague', '420', 'czech republic|czechia'],
  ['Europe/Budapest', '36', 'hungary'], ['Europe/Zagreb', '385', 'croatia'], ['Europe/Belgrade', '381', 'serbia'],
  ['Europe/Helsinki', '358', 'finland'], ['Europe/Athens', '30', 'greece'], ['Europe/Bucharest', '40', 'romania'],
  ['Europe/Sofia', '359', 'bulgaria'], ['Europe/Kyiv', '380', 'ukraine'], ['Europe/Istanbul', '90', 'turkey'],
  ['Europe/Moscow', '7', 'russia'], ['Asia/Jerusalem', '972', 'israel'],
  ['Europe/Vilnius', '370', 'lithuania'], ['Europe/Riga', '371', 'latvia'], ['Europe/Tallinn', '372', 'estonia'],
  ['Asia/Dubai', '971', 'united arab emirates|uae|u.a.e.|dubai'], ['Asia/Muscat', '968', 'oman'],
  ['Asia/Riyadh', '966', 'saudi arabia|ksa'], ['Asia/Qatar', '974', 'qatar'], ['Asia/Kuwait', '965', 'kuwait'],
  ['Asia/Bahrain', '973', 'bahrain'], ['Asia/Amman', '962', 'jordan'], ['Asia/Beirut', '961', 'lebanon'], ['Asia/Baghdad', '964', 'iraq'],
  ['Africa/Lagos', '234', 'nigeria'], ['Africa/Casablanca', '212', 'morocco'], ['Africa/Algiers', '213', 'algeria'],
  ['Africa/Tunis', '216', 'tunisia'], ['Africa/Accra', '233', 'ghana'], ['Africa/Dakar', '221', 'senegal'], ['Africa/Abidjan', '225', 'ivory coast'],
  ['Africa/Johannesburg', '27', 'south africa'], ['Africa/Lusaka', '260', 'zambia'], ['Africa/Harare', '263', 'zimbabwe'],
  ['Africa/Gaborone', '267', 'botswana'], ['Africa/Kigali', '250', 'rwanda'], ['Africa/Maputo', '258', 'mozambique'],
  ['Africa/Cairo', '20', 'egypt'], ['Africa/Nairobi', '254', 'kenya'], ['Africa/Dar_es_Salaam', '255', 'tanzania'],
  ['Africa/Kampala', '256', 'uganda'], ['Africa/Addis_Ababa', '251', 'ethiopia'],
  ['Asia/Singapore', '65', 'singapore'], ['Asia/Shanghai', '86', 'china'], ['Asia/Kuala_Lumpur', '60', 'malaysia'],
  ['Asia/Hong_Kong', '852', 'hong kong'], ['Asia/Manila', '63', 'philippines'], ['Asia/Taipei', '886', 'taiwan'],
  ['Asia/Bangkok', '66', 'thailand'], ['Asia/Ho_Chi_Minh', '84', 'vietnam'], ['Asia/Jakarta', '62', 'indonesia'],
  ['Asia/Phnom_Penh', '855', 'cambodia'], ['Asia/Tokyo', '81', 'japan'], ['Asia/Seoul', '82', 'south korea|korea'],
  ['Australia/Sydney', '61', 'australia'], ['Pacific/Auckland', '64', 'new zealand'],
  ['Asia/Karachi', '92', 'pakistan'], ['Asia/Dhaka', '880', 'bangladesh'], ['Asia/Colombo', '94', 'sri lanka'],
  ['Asia/Kathmandu', '977', 'nepal'], ['Asia/Aden', '967', 'yemen'], ['Asia/Tbilisi', '995', 'georgia'],
  ['Asia/Vientiane', '856', 'lao|laos'], ['America/La_Paz', '591', 'bolivia'], ['America/Puerto_Rico', '', 'puerto rico'],
  ['America/Guayaquil', '593', 'ecuador'], ['America/Santiago', '56', 'chile'], ['America/Costa_Rica', '506', 'costa rica'],
];
const byName = new Map(ZONES.flatMap(([zone, , names]) => names.split('|').map((name) => [name, zone])));
const byCode = new Map(ZONES.filter(([, code]) => code).map(([zone, code]) => [code, zone]));
const C = (region, ...names) => names.map((n) => [n, { timezone: byName.get(n), region }]);

export const COUNTRIES = new Map([
  ...C('india', 'india', 'in', 'bharat'),

  // Americas -> us
  ...C('us', 'united states', 'usa', 'us', 'united states of america', 'u.s.', 'u.s.a.', 'canada'),
  ...C('us', 'mexico'),
  ...C('us', 'colombia', 'peru'),
  ...C('us', 'brazil', 'argentina'),

  // UK / Europe -> eu
  ...C('eu', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'ireland', 'portugal'),
  ...C('eu', 'germany', 'france', 'netherlands', 'spain', 'italy', 'belgium', 'switzerland', 'austria',
       'sweden', 'norway', 'denmark', 'poland', 'czech republic', 'czechia', 'hungary', 'croatia', 'serbia'),
  ...C('eu', 'finland', 'greece', 'romania', 'bulgaria', 'ukraine', 'turkey', 'russia', 'israel',
       'lithuania', 'latvia', 'estonia'),

  // Middle East -> eu
  ...C('eu', 'united arab emirates', 'uae', 'u.a.e.', 'dubai', 'oman'),
  ...C('eu', 'saudi arabia', 'ksa', 'qatar', 'kuwait', 'bahrain', 'jordan', 'lebanon', 'iraq'),
  // Iran (+98) is deliberately absent: Telnyx cannot route it (sanctions, docs/TELNYX-COVERAGE.md s4), so a
  // lead there gets no timezone and sits in "No country" instead of failing every 10 minutes for ever.

  // Africa -> eu
  ...C('eu', 'nigeria', 'morocco', 'algeria', 'tunisia'),
  ...C('eu', 'ghana', 'senegal', 'ivory coast'),
  ...C('eu', 'south africa', 'zambia', 'zimbabwe', 'botswana', 'rwanda', 'mozambique'),
  ...C('eu', 'egypt', 'kenya', 'tanzania', 'uganda', 'ethiopia'),

  // APAC -> us (plan: US number is the APAC fallback)
  ...C('us', 'singapore', 'china', 'malaysia', 'hong kong', 'philippines', 'taiwan'),
  ...C('us', 'thailand', 'vietnam', 'indonesia', 'cambodia'),
  ...C('us', 'japan', 'south korea', 'korea'),
  ...C('us', 'australia'),
  ...C('us', 'new zealand'),
  ...C('us', 'pakistan'),
  ...C('us', 'bangladesh'),
  ...C('us', 'sri lanka'),
  ...C('us', 'nepal'),
  // Additional countries supported by the dialer.
  ...C('eu', 'switzerland', 'germany', 'netherlands', 'belgium', 'france', 'italy', 'austria', 'norway', 'poland', 'spain', 'sweden', 'denmark'),
  ...C('eu', 'finland', 'israel', 'turkey', 'yemen'),
  ...C('eu', 'georgia'),
  ...C('us', 'lao', 'laos'),
  ...C('us', 'bolivia', 'puerto rico'),
  ...C('us', 'ecuador'),
  ...C('us', 'chile'),
  ...C('us', 'costa rica'),
]);

const D = (region, ...codes) => codes.map((c) => [c, { timezone: byCode.get(c), region }]);

export const DIAL_CODES = new Map([
  ...D('india', '91'),
  ...D('us', '1'), // plan s4: assume US East
  ...D('us', '52'), ...D('us', '57', '51'), ...D('us', '55', '54'),
  ...D('eu', '44', '353', '351', '234', '212', '213', '216'),
  ...D('eu', '233', '221', '225'),
  ...D('eu', '49', '33', '31', '34', '39', '32', '41', '43', '46', '47', '45', '48', '420', '36', '385', '381', '27', '260', '263', '267', '250', '258'),
  ...D('eu', '358', '30', '40', '359', '380', '90', '7', '972', '966', '974', '965', '973', '962', '961', '964', '20', '254', '255', '256', '251'),
  ...D('eu', '971', '968'),
  ...D('us', '65', '86', '60', '852', '63', '886'),
  ...D('us', '66', '84', '62', '855'),
  ...D('us', '81', '82'),
  ...D('us', '61'), ...D('us', '64'),
  ...D('us', '92'), ...D('us', '880'), ...D('us', '94'), ...D('us', '977'),
]);

const norm = (s) => (s ?? '').toString().trim().toLowerCase().replace(/ +/g, ' ');

/** @returns {{offset:number, region:'india'|'eu'|'us', source:'country'|'dial_code'} | null} */
export function offsetAt(timezone, at = new Date()) {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(at).find((p) => p.type === 'timeZoneName').value;
  const m = zone.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 0;
}
export function resolveLead({ country, phone }, at = new Date()) {
  const result = (hit, source) => ({ ...hit, offset: offsetAt(hit.timezone, at), source });
  const byCountry = COUNTRIES.get(norm(country));
  if (byCountry) return result(byCountry, 'country');

  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/[^0-9+]/g, '').replace(/^[+]/, '').replace(/^00/, '');
  // Only trust the dial code when the number actually carries one. A bare 10-digit local
  // number would otherwise mis-resolve (an Indian mobile starting 98... would become Iran).
  if (!(raw.startsWith('+') || raw.startsWith('00') || digits.length > 10)) return null;
  for (let len = 3; len >= 1; len--) {
    const hit = DIAL_CODES.get(digits.slice(0, len));
    if (hit) return result(hit, 'dial_code');
  }
  return null;
}

export const segmentFor = (region) => (region === 'india' ? 'india' : 'non_india');
