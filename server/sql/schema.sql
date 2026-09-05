-- Eazybe Dialer MVP schema (plan §6, plus `bursts` to settle the bridge race)

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
