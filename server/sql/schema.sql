-- Hans Dialer MVP schema (plan §6, plus `bursts` to settle the bridge race)

CREATE TABLE IF NOT EXISTS users (
  id                      SERIAL PRIMARY KEY,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  phone                   TEXT,
  rep_leg_destination     TEXT,          -- PSTN number today, sip:... on Sunday. The only field that changes.
  telnyx_session_call_id  TEXT           -- call_control_id of the open rep leg, NULL when disconnected
);

CREATE TABLE IF NOT EXISTS leads (
  id                  SERIAL PRIMARY KEY,
  hubspot_contact_id  TEXT UNIQUE,
  name                TEXT,
  phone               TEXT NOT NULL,
  country             TEXT,
  utc_offset          NUMERIC(4,2),      -- hours from UTC, e.g. 5.5, -5
  segment             TEXT NOT NULL CHECK (segment IN ('india','non_india')),
  attempt_count       INT  NOT NULL DEFAULT 0,
  last_call_at        TIMESTAMPTZ,
  next_call_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','in_flight','connected','later','exhausted','stopped'))
);
CREATE INDEX IF NOT EXISTS leads_queue_idx ON leads (status, next_call_at);

-- One row per "Start calling" click. winner_call_id is claimed atomically by the
-- first call.answered webhook; the losing leg sees it already set and hangs up.
CREATE TABLE IF NOT EXISTS bursts (
  id              SERIAL PRIMARY KEY,
  user_id         INT REFERENCES users(id),
  winner_call_id  INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id              SERIAL PRIMARY KEY,
  lead_id         INT REFERENCES leads(id),
  burst_id        INT REFERENCES bursts(id),
  telnyx_call_id  TEXT UNIQUE,           -- call_control_id
  from_number     TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at     TIMESTAMPTZ,
  duration        INT,                   -- seconds, set on hangup
  disposition     TEXT                   -- connected | no_answer | later | cancelled | failed
);

-- Browser audio (plan §9): per-user audio mode and the Telnyx on-demand credential that logs the
-- WebRTC softphone in. rep_leg_destination becomes sip:<sip_username>@sip.telnyx.com in browser mode.
ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_mode TEXT NOT NULL DEFAULT 'phone' CHECK (audio_mode IN ('phone','browser'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS telnyx_credential_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sip_username TEXT;

-- Rep's note per call, saved with the disposition; shown as "last note" next time the lead comes up.
-- Will map to a HubSpot note/property once HubSpot write-back lands (after the Monday measurement).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS notes TEXT;

-- Everything else the CSV knows about a lead (email, company, lead stage, lifecycle, origin, HubSpot URL),
-- shown on the call card. Replaced by live HubSpot properties once sync lands.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Leads belong to one rep (PLAN-v2: never shared across the team). Queue selection, Up next, stats and the
-- activity feed are all scoped by it. Rows from before ownership existed go to the first rep, once.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads (user_id, status, next_call_at);
UPDATE leads SET user_id = (SELECT id FROM users WHERE email = 'himanshu@hansmatrimony.com') WHERE user_id IS NULL;

-- When the rep saved the outcome: wrap-up time = dispositioned_at - (answered_at + duration). Manual Next
-- makes this the one number the measurement day should see (PLAN-v2).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dispositioned_at TIMESTAMPTZ;

-- Multi-number leads: a lead carries up to 3 numbers (CSV "Phone Number" + "Alternate number 1/2").
-- `phones` is the ordered list, `phone_idx` (1-based) points at the one in play, and `phone` is
-- always phones[phone_idx] - so every existing reader of leads.phone shows the number being dialed
-- now. `number_attempts` counts tries spent on the current number; releaseLead() rolls to the next
-- one when it runs out. calls.to_number records what was actually dialed, because leads.phone moves.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phones          TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_idx       INT    NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS number_attempts INT    NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS to_number       TEXT;

-- Backfill, in this order: stamping history from leads.phone is only correct while phone has
-- never moved, so it must run before any cascade code goes live.
UPDATE calls c SET to_number = l.phone FROM leads l WHERE l.id = c.lead_id AND c.to_number IS NULL;
UPDATE leads SET phones = ARRAY[phone] WHERE cardinality(phones) = 0;

-- Call-card v2: the rep picks one of seven outcome tiles, which collapse onto the four dispositions
-- above. `sub_outcome` records the tile itself (interested | follow_up | callback | not_interested |
-- not_qualified) so the run tape and later reporting can tell a good connect from a dead one; `reason`
-- is the optional "why not" chip on Not interested. Both nullable: existing rows and the no-reach
-- tiles (No answer / Wrong number) leave them empty. disposition keeps its four values untouched.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sub_outcome TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reason      TEXT;

-- HubSpot inlet (docs/HUBSPOT-QUEUE.md). A rep ticks `hans_dial_queue` on a contact they own and a
-- poll pulls it into that rep's queue. Live toggle: unticking removes a queued lead, re-ticking brings
-- it back. Owner id and user id are both kept because HubSpot's two id spaces disagree for some users
-- (Karan Dewan is owner 578081029 but user 61259763); owners are matched to reps by email, never hardcoded.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hubspot_owner_id  BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hubspot_user_id   BIGINT;
-- Start time of the last pull that completed for this rep. Two jobs: it is what "was this lead ticked
-- at the previous poll?" is measured against (re-tick detection, below), and a gap larger than
-- RETICK_MAX_GAP_MS marks the answer untrustworthy so a server restart cannot resurrect finished leads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hubspot_synced_at TIMESTAMPTZ;
-- The last pull that changed this rep's queue ({at, added, resumed, reopened, removed, skipped, ticked}),
-- so Up next can say "25 pulled 19 min ago" after a redeploy too - exactly when a rep asks "did they arrive?".
ALTER TABLE users ADD COLUMN IF NOT EXISTS hubspot_last_change JSONB;

-- Which inlet a lead came through. Existing rows are CSV apart from the keypad's manual-<phone> ones.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'csv';
-- A 'manual-<phone>' key does NOT mean a hand-dialled number: importCsv falls back to it for any
-- CSV row whose export carried neither a Record ID nor an email, and on this database 289 of 310 such
-- rows are spreadsheet leads. A real keypad dial is the row nothing else ever filled in - no country
-- (INSERT in /dial does not set one) and none of the columns only a spreadsheet supplies.
UPDATE leads SET source = 'manual'
 WHERE source = 'csv' AND hubspot_contact_id LIKE 'manual-%'
   AND country IS NULL
   AND NOT extra ?| array['email', 'origin', 'leadStage', 'lifecycle', 'priority', 'title', 'linkedin', 'hubspotUrl'];

-- Stamped with the pull's start time every time HubSpot reports this lead as still ticked. A lead that
-- comes back ticked with a stamp older than the previous pull was unticked and re-ticked in between:
-- that, and only that, is how an SDR asks for a fresh run at a lead we already finished.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hubspot_seen_at TIMESTAMPTZ;
-- Why a lead stopped. 'hubspot_untick' today; NULL on every pre-existing and non-HubSpot path.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stopped_reason TEXT;
CREATE INDEX IF NOT EXISTS leads_source_idx ON leads (user_id, source, status);

-- Keypad duplicates (2026-09-11): dialling an existing lead from the keypad used to make a second,
-- nameless 'manual-<phone>' row that releaseLead kept requeueing as a bare number. Stop the copy;
-- the real row keeps the queue slot. Its calls stay on it (the admin drawer still shows them).
UPDATE leads m SET status = 'stopped', stopped_reason = 'duplicate'
 WHERE m.hubspot_contact_id LIKE 'manual-%' AND m.name IS NULL AND m.status IN ('queued', 'later')
   AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id = m.user_id AND l.id <> m.id
               AND l.hubspot_contact_id NOT LIKE 'manual-%' AND l.phones && m.phones);

-- ===== Admin dashboard, wallet, recordings, HubSpot call logging (plan 2026-09-10) =====

-- Roles: reps are the default; one admin (marketing@hansmatrimony.com) sees every rep and never dials.
-- Removing a rep deactivates them (login refused, rep leg hung up) and keeps every lead and call.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role           TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('rep', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS active         BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
UPDATE users SET role = 'admin' WHERE email = 'marketing@hansmatrimony.com' AND role <> 'admin';

-- When a leg ended, answered or not: ring time for a no-answer is ended_at - started_at.
-- duration stays talk time and stays NULL on unanswered legs, so nothing that reads it changes.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS calls_started_idx ON calls (started_at);
CREATE INDEX IF NOT EXISTS calls_burst_idx   ON calls (burst_id);

-- Telnyx spend (Wallet). One row per call.cost webhook, keyed by the leg so a retry upserts instead of
-- double-counting. Every leg we place costs money - lead legs, cancelled loser legs, dial failures with
-- no calls row, and the rep's own session leg (kind='rep') - so this is its own table, not calls columns.
CREATE TABLE IF NOT EXISTS telnyx_costs (
  call_control_id TEXT PRIMARY KEY,
  call_leg_id     TEXT,
  call_session_id TEXT,
  kind            TEXT,                          -- 'rep' | 'lead' | NULL (no client_state)
  user_id         INT REFERENCES users(id),
  call_id         INT REFERENCES calls(id),      -- from calls.telnyx_call_id when a row exists
  occurred_at     TIMESTAMPTZ NOT NULL,
  total_cost      NUMERIC(12,6) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  billed_secs     INT,
  status          TEXT,                          -- 'success' | 'error'
  parts           JSONB NOT NULL DEFAULT '[]'::jsonb,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telnyx_costs_at_idx   ON telnyx_costs (occurred_at);
CREATE INDEX IF NOT EXISTS telnyx_costs_user_idx ON telnyx_costs (user_id, occurred_at);

-- Call recordings: the winning lead leg is recorded from the bridge (dual channel, mp3, Telnyx-hosted).
-- The saved webhook's links expire in 10 min and are NOT stored; playback resolves a fresh link through
-- the Recordings API and caches the recording id. recording_token is the public handle: /rec/<token>.mp3
-- serves the dashboard player (and HubSpot, until the file copy exists); nulling it revokes the link.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_status     TEXT;          -- 'started' | 'saved' | 'error'
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_token      TEXT UNIQUE;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_leg_id     TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_session_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_id         TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_started_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_ended_at   TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_error      TEXT;
-- HubSpot Call engagement created for this dial (write-back, calls only), and the copy of the
-- recording uploaded into HubSpot Files so HubSpot owns it (the Telnyx copy stays for the dashboard).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_call_id      TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_file_id      TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_file_url     TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_error        TEXT;         -- last failure, plain words; NULL once it works

-- Admin toggles. hubspot_create_contacts: make a HubSpot contact for a dialed number that has none
-- (default off - with it off, calls to unknown numbers are never pushed to HubSpot at all).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO settings (key, value) VALUES ('hubspot_create_contacts', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;

-- Reliability: acknowledged provider events and CRM work survive a process restart.
CREATE TABLE IF NOT EXISTS telnyx_events (
  id TEXT PRIMARY KEY,
  event JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT
);
CREATE INDEX IF NOT EXISTS telnyx_events_pending_idx ON telnyx_events (next_attempt_at) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS hubspot_jobs (
  call_id INT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT
);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS bridged_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_sync_key UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hubspot_create_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rep_connected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS retry_minutes INT;

-- Plivo uses a request UUID before the live call UUID is assigned. The stable local ID
-- is stored in the existing telnyx_call_id/session columns; historical rows are untouched.
CREATE TABLE IF NOT EXISTS plivo_calls (
  id TEXT PRIMARY KEY,
  request_uuid TEXT UNIQUE,
  call_uuid TEXT UNIQUE,
  state JSONB NOT NULL,
  conference_name TEXT,
  member_id TEXT,
  bridge_room TEXT,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plivo_endpoint_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plivo_sip_username TEXT;


-- Manual CRM exports: stable identity per rep; replay does not reset a lead.
CREATE TABLE IF NOT EXISTS crm_queue_links (
 rep_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 external_id TEXT NOT NULL,
 lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (rep_id, external_id)
);
