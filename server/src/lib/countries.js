// Static country -> { offset, region } lookup (plan s4, s5). No library.
//
// offset  = hours from UTC as of Sept 2026, i.e. northern-hemisphere DST in effect.
//           Revisit late October when US/UK/EU fall back and AU/NZ spring forward.
// region  = which caller ID dials this lead:
//           india -> FROM_NUMBER_INDIA, eu -> FROM_NUMBER_EU, us -> FROM_NUMBER_US (APAC falls back to us)
//
// Timezone is derived from the HubSpot `country` property FIRST; the dial code is only the
// fallback for blank country. An Indian lead with a +1 number still resolves to India.

const C = (offset, region, ...names) => names.map((n) => [n, { offset, region }]);

export const COUNTRIES = new Map([
  ...C(5.5, 'india', 'india', 'in', 'bharat'),

  // Americas -> us
  ...C(-4, 'us', 'united states', 'usa', 'us', 'united states of america', 'u.s.', 'u.s.a.', 'canada'),
  ...C(-6, 'us', 'mexico'),
  ...C(-5, 'us', 'colombia', 'peru'),
  ...C(-3, 'us', 'brazil', 'argentina'),

  // UK / Europe -> eu
  ...C(1, 'eu', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'ireland', 'portugal'),
  ...C(2, 'eu', 'germany', 'france', 'netherlands', 'spain', 'italy', 'belgium', 'switzerland', 'austria',
       'sweden', 'norway', 'denmark', 'poland', 'czech republic', 'czechia', 'hungary', 'croatia', 'serbia'),
  ...C(3, 'eu', 'finland', 'greece', 'romania', 'bulgaria', 'ukraine', 'turkey', 'russia', 'israel',
       'lithuania', 'latvia', 'estonia'),

  // Middle East -> eu
  ...C(4, 'eu', 'united arab emirates', 'uae', 'u.a.e.', 'dubai', 'oman'),
  ...C(3, 'eu', 'saudi arabia', 'ksa', 'qatar', 'kuwait', 'bahrain', 'jordan', 'lebanon', 'iraq'),
  // Iran (+98) is deliberately absent: Telnyx cannot route it (sanctions, docs/TELNYX-COVERAGE.md s4), so a
  // lead there gets no timezone and sits in "No country" instead of failing every 10 minutes for ever.

  // Africa -> eu
  ...C(1, 'eu', 'nigeria', 'morocco', 'algeria', 'tunisia'),
  ...C(0, 'eu', 'ghana', 'senegal', 'ivory coast'),
  ...C(2, 'eu', 'south africa', 'zambia', 'zimbabwe', 'botswana', 'rwanda', 'mozambique'),
  ...C(3, 'eu', 'egypt', 'kenya', 'tanzania', 'uganda', 'ethiopia'),

  // APAC -> us (plan: US number is the APAC fallback)
  ...C(8, 'us', 'singapore', 'china', 'malaysia', 'hong kong', 'philippines', 'taiwan'),
  ...C(7, 'us', 'thailand', 'vietnam', 'indonesia', 'cambodia'),
  ...C(9, 'us', 'japan', 'south korea', 'korea'),
  ...C(10, 'us', 'australia'),
  ...C(12, 'us', 'new zealand'),
  ...C(5, 'us', 'pakistan'),
  ...C(6, 'us', 'bangladesh'),
  ...C(5.5, 'us', 'sri lanka'),
  ...C(5.75, 'us', 'nepal'),
  // Added 2026-09-05 from Himanshu's priority list. Fixed offsets, valid for Sept (EU on CEST).
  ...C(2, 'eu', 'switzerland', 'germany', 'netherlands', 'belgium', 'france', 'italy', 'austria', 'norway', 'poland', 'spain', 'sweden', 'denmark'),
  ...C(3, 'eu', 'finland', 'israel', 'turkey', 'yemen'),
  ...C(4, 'eu', 'georgia'),
  ...C(7, 'us', 'lao', 'laos'),
  ...C(-4, 'us', 'bolivia', 'puerto rico'),
  ...C(-5, 'us', 'ecuador'),
  ...C(-3, 'us', 'chile'),
  ...C(-6, 'us', 'costa rica'),
]);

const D = (offset, region, ...codes) => codes.map((c) => [c, { offset, region }]);

export const DIAL_CODES = new Map([
  ...D(5.5, 'india', '91'),
  ...D(-4, 'us', '1'), // plan s4: assume US East
  ...D(-6, 'us', '52'), ...D(-5, 'us', '57', '51'), ...D(-3, 'us', '55', '54'),
  ...D(1, 'eu', '44', '353', '351', '234', '212', '213', '216'),
  ...D(0, 'eu', '233', '221', '225'),
  ...D(2, 'eu', '49', '33', '31', '34', '39', '32', '41', '43', '46', '47', '45', '48', '420', '36', '385', '381', '27', '260', '263', '267', '250', '258'),
  ...D(3, 'eu', '358', '30', '40', '359', '380', '90', '7', '972', '966', '974', '965', '973', '962', '961', '964', '20', '254', '255', '256', '251'),
  ...D(4, 'eu', '971', '968'),
  ...D(8, 'us', '65', '86', '60', '852', '63', '886'),
  ...D(7, 'us', '66', '84', '62', '855'),
  ...D(9, 'us', '81', '82'),
  ...D(10, 'us', '61'), ...D(12, 'us', '64'),
  ...D(5, 'us', '92'), ...D(6, 'us', '880'), ...D(5.5, 'us', '94'), ...D(5.75, 'us', '977'),
]);

const norm = (s) => (s ?? '').toString().trim().toLowerCase().replace(/ +/g, ' ');

/** @returns {{offset:number, region:'india'|'eu'|'us', source:'country'|'dial_code'} | null} */
export function resolveLead({ country, phone }) {
  const byCountry = COUNTRIES.get(norm(country));
  if (byCountry) return { ...byCountry, source: 'country' };

  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/[^0-9+]/g, '').replace(/^[+]/, '').replace(/^00/, '');
  // Only trust the dial code when the number actually carries one. A bare 10-digit local
  // number would otherwise mis-resolve (an Indian mobile starting 98... would become Iran).
  if (!(raw.startsWith('+') || raw.startsWith('00') || digits.length > 10)) return null;
  for (let len = 3; len >= 1; len--) {
    const hit = DIAL_CODES.get(digits.slice(0, len));
    if (hit) return { ...hit, source: 'dial_code' };
  }
  return null;
}

export const segmentFor = (region) => (region === 'india' ? 'india' : 'non_india');
