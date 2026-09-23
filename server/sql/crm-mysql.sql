CREATE TABLE IF NOT EXISTS hans_calling_admins (
  id VARCHAR(64) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL, active TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS hans_calling_agents (
  crm_user_id BIGINT PRIMARY KEY, endpoint_id VARCHAR(128), sip_username VARCHAR(128),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS hans_calling_sessions (
  id CHAR(36) PRIMARY KEY, crm_user_id BIGINT NOT NULL, owner_token CHAR(36) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'starting', request_uuid VARCHAR(128), call_uuid VARCHAR(128),
  ready_at DATETIME(3), ended_at DATETIME(3), hangup_cause VARCHAR(128),
  stop_requested TINYINT NOT NULL DEFAULT 0, cost_usd DECIMAL(14,6), bill_seconds INT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX sessions_user (crm_user_id, ended_at), INDEX sessions_idle (ended_at, activity_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS hans_calling_calls (
  id CHAR(36) PRIMARY KEY, crm_user_id BIGINT NOT NULL, request_id BIGINT NOT NULL,
  session_id CHAR(36) NOT NULL, idempotency_key CHAR(36) NOT NULL,
  lead_id BIGINT NOT NULL, lead_type INT NOT NULL, lead_name VARCHAR(255), phone VARCHAR(24) NOT NULL,
  from_number VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'starting',
  request_uuid VARCHAR(128), call_uuid VARCHAR(128), stop_requested TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), answered_at DATETIME(3),
  ended_at DATETIME(3), hangup_cause VARCHAR(128), bill_seconds INT, cost_usd DECIMAL(14,6),
  recording_id VARCHAR(128), recording_started TINYINT NOT NULL DEFAULT 0,
  UNIQUE KEY calls_idempotency (crm_user_id, idempotency_key),
  INDEX calls_user (crm_user_id, created_at), INDEX calls_session (session_id, ended_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS hans_calling_auto_leads (
  id CHAR(36) PRIMARY KEY, crm_user_id BIGINT NOT NULL,
  active_user BIGINT UNIQUE, active_phone VARCHAR(24) UNIQUE,
  lead_id BIGINT NOT NULL, lead_type INT NOT NULL,
  lead_name VARCHAR(255), phone VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'reserved', outcome VARCHAR(32), disposition VARCHAR(16),
  request_id BIGINT, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3), INDEX auto_user (crm_user_id, created_at), INDEX auto_source (lead_type, lead_id)
) ENGINE=InnoDB;
