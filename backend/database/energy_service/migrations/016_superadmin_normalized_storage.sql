CREATE SCHEMA IF NOT EXISTS superadmin;

CREATE TABLE IF NOT EXISTS superadmin.users (
  id UUID PRIMARY KEY,
  public_user_id UUID REFERENCES public.users (id) ON DELETE SET NULL,
  user_code VARCHAR(16) UNIQUE,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_file VARCHAR(64),
  avatar_content_type VARCHAR(32),
  profile_completed_at TIMESTAMPTZ,
  permissions_assigned_by_id UUID REFERENCES superadmin.users (id) ON DELETE SET NULL,
  permissions_assigned_by_name VARCHAR(120),
  permissions_assigned_by_email VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS superadmin.role_permissions (
  role VARCHAR(20) NOT NULL,
  page VARCHAR(40) NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_create BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (role, page)
);

CREATE TABLE IF NOT EXISTS superadmin.user_permissions (
  user_id UUID NOT NULL REFERENCES superadmin.users (id) ON DELETE CASCADE,
  page VARCHAR(40) NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_create BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, page)
);

CREATE TABLE IF NOT EXISTS superadmin.audit_events (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES superadmin.users (id) ON DELETE SET NULL,
  actor_email VARCHAR(255),
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS superadmin.company_profile (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  company_name VARCHAR(255) NOT NULL DEFAULT '',
  phone VARCHAR(40) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  gstin VARCHAR(40) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS superadmin_audit_actor_idx
  ON superadmin.audit_events (actor_id, occurred_at);
CREATE INDEX IF NOT EXISTS superadmin_audit_target_idx
  ON superadmin.audit_events (target_type, target_id);

DO $$
BEGIN
  IF to_regclass('superadmin.console_sessions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='superadmin' AND table_name='console_sessions'
        AND column_name='user_id' AND data_type='text'
    ) THEN
      ALTER TABLE superadmin.console_sessions
        ALTER COLUMN user_id TYPE UUID USING user_id::uuid;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='superadmin' AND table_name='console_sessions'
        AND column_name='actor_id' AND data_type='text'
    ) THEN
      ALTER TABLE superadmin.console_sessions
        ALTER COLUMN actor_id TYPE UUID USING actor_id::uuid;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS superadmin.console_state;
