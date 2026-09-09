// The slot resolver (call-card v2). The card never reads a CSV column or a HubSpot property by name;
// it reads seven named slots, and this pure module fills them from whatever `leads.extra` holds. CSV
// leads and HubSpot leads land in the same JSONB, so one component serves both - and adding a HubSpot
// property later is a data change, not a UI change. Two rules do most of the work here:
//   1. Empty never renders. A slot with nothing collapses; the rows below move up.
//   2. The drawer states its size, and isn't built at all when there is nothing left over.
import type { Card } from './useDialer';
import { splitName } from './format';

export type WhyRow = { label: string; value: string };
export type ReachItem = { kind: 'email' | 'linkedin' | 'hubspot' | 'phone'; label: string; href?: string };
export type MoreRow = { label: string; value: string };
export type ResolvedLead = {
  name: string | null;
  role: string | null;      // job title
  company: string | null;
  headline: string | null;         // what leads the card: name, else company, else null (caller shows the number)
  headlineKind: 'name' | 'company' | 'number';
  why: WhyRow[];             // up to 3, the rail's top panel
  reach: ReachItem[];        // email / LinkedIn / CRM record / alternates
  more: MoreRow[];           // HubSpot leftovers, the drawer
  isUnknown: boolean;        // a manual dial with nothing on file
  needsName: boolean;        // a lead we can dial but with no contact name - offer to add one
  nudge: string | null;      // thin CSV row: which column would fill the gap
};

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const isUrl = (s: string) => /^https?:\/\//.test(s);

// CSV rows arrive already normalised into these typed keys (server/src/lib/import.js). Walked first.
const CSV_WHY: [keyof CardExtra, string][] = [
  ['leadStage', 'Lead stage'],
  ['origin', 'Source'],
  ['lifecycle', 'Lifecycle'],
];
type CardExtra = Record<string, unknown>;

// HubSpot properties (once the pull sync lands) arrive under their raw internal names. Walked after the
// CSV keys; the first three non-empty across both fill the panel, the rest fall to the drawer.
const HS_WHY: [string, string][] = [
  ['hs_lead_status', 'Lead status'],
  ['hs_analytics_source', 'Source'],
  ['lifecyclestage', 'Lifecycle'],
  ['notes_last_activity_date', 'Last activity'],
  ['industry', 'Industry'],
  ['numberofemployees', 'Company size'],
];

// Keys the card already spends elsewhere (identity, reach) or that are pure plumbing: never shown twice
// and never dumped into the drawer.
const CONSUMED = new Set(['company', 'title', 'email', 'linkedin', 'hubspoturl', 'hubspot_url', 'priority']);

/** snake_case / camelCase HubSpot key -> a human label for the drawer. */
function humanize(key: string): string {
  const s = key.replace(/^hs_/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

export function resolveLead(c: Card): ResolvedLead {
  const extra = (c.extra ?? {}) as CardExtra;
  const { name, company: nameCompany } = splitName(c.name);
  const company = str(extra.company) || nameCompany || null;
  const role = str(extra.title) || null;

  const isManual = (c.hubspotId ?? '').startsWith('manual-');
  const hasIdentity = !!(name || company || role);
  const isUnknown = isManual && !hasIdentity && !str(extra.email);

  // WHY - CSV keys, then the HubSpot ladder; first three non-empty win, deduped by label.
  const why: WhyRow[] = [];
  const consumed = new Set(CONSUMED);
  const pushWhy = (label: string, value: string) => {
    if (value && why.length < 3 && !why.some((w) => w.label === label)) why.push({ label, value });
  };
  for (const [key, label] of CSV_WHY) { pushWhy(label, str(extra[key])); consumed.add(String(key).toLowerCase()); }
  for (const [key, label] of HS_WHY) { pushWhy(label, str(extra[key])); consumed.add(key.toLowerCase()); }

  // REACH
  const reach: ReachItem[] = [];
  const email = str(extra.email);
  if (email) reach.push({ kind: 'email', label: email, href: 'mailto:' + email });
  const li = str(extra.linkedin);
  if (li) reach.push({ kind: 'linkedin', label: isUrl(li) ? 'LinkedIn profile' : li, href: isUrl(li) ? li : undefined });
  const hs = str(extra.hubspotUrl) || str((extra as CardExtra).hubspot_url);
  if (hs && isUrl(hs)) reach.push({ kind: 'hubspot', label: 'HubSpot record', href: hs });
  // The lead's other numbers, in the order the dialer will roll onto them.
  for (const p of (c.phones ?? []).filter((n) => n && n !== c.phone)) reach.push({ kind: 'phone', label: p });

  // MORE - every remaining non-empty property, in HubSpot's own order. CSV has none left over.
  const more: MoreRow[] = [];
  for (const [k, v] of Object.entries(extra)) {
    const val = str(v);
    if (!val || consumed.has(k.toLowerCase())) continue;
    more.push({ label: humanize(k), value: isUrl(val) ? 'link' : val });
  }

  // A thin CSV row can be made richer from the spreadsheet; a thin HubSpot record can't, so it says nothing.
  const nudge = !isManual && !isUnknown && why.length === 0
    ? 'From your CSV — add a Lead Stage or Source column to fill this in.'
    : null;

  // The card leads with the person; with no name it leads with the company (the rep still knows who they
  // are calling at a glance) and drops the number to a secondary line. Only a bare number falls back to it.
  const headline = name || company || null;
  const headlineKind: ResolvedLead['headlineKind'] = name ? 'name' : company ? 'company' : 'number';
  const needsName = !name && !isUnknown; // a real lead (usually a company) that simply has no contact name yet

  return { name, role, company, headline, headlineKind, why, reach, more, isUnknown, needsName, nudge };
}
