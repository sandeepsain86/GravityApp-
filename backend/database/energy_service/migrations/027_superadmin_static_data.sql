-- Migration 027: Superadmin static data tables
-- Moves all hardcoded static data from code into database tables.
-- Safe to run more than once.

CREATE SCHEMA IF NOT EXISTS superadmin;

-- Onboarding statuses (replaces ONBOARDING constants in onboarding.js)
CREATE TABLE IF NOT EXISTS superadmin.onboarding_statuses (
  code VARCHAR(40) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO superadmin.onboarding_statuses (code, label, sort_order, is_terminal) VALUES
  ('OTP_PENDING', 'OTP Pending', 1, FALSE),
  ('PHONE_VERIFIED', 'Phone Verified', 2, FALSE),
  ('COMPANY_PENDING', 'Company Pending', 3, FALSE),
  ('COMPANY_COMPLETED', 'Company Completed', 4, FALSE),
  ('SITES_PENDING', 'Sites Pending', 5, FALSE),
  ('SITES_COMPLETED', 'Sites Completed', 6, FALSE),
  ('PROFILE_PENDING', 'Profile Pending', 7, FALSE),
  ('ONBOARDING_COMPLETED', 'Onboarding Completed', 8, TRUE)
ON CONFLICT (code) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal;

-- Superadmin pages (replaces PAGES array in permissions.ts)
CREATE TABLE IF NOT EXISTS superadmin.pages (
  key VARCHAR(40) PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  group_name VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO superadmin.pages (key, label, group_name, sort_order, is_active) VALUES
  ('dashboard', 'Dashboard', 'Overview', 1, TRUE),
  ('analytics', 'Analytics', 'Overview', 2, TRUE),
  ('livemonitor', 'Live Monitor', 'Operations', 3, TRUE),
  ('jobs', 'Jobs', 'Operations', 4, TRUE),
  ('repair', 'Repair Center', 'Operations', 5, TRUE),
  ('projects', 'Projects', 'Operations', 6, TRUE),
  ('inventory', 'Inventory', 'Operations', 7, TRUE),
  ('verification', 'Verification', 'Field Partners', 8, TRUE),
  ('disputes', 'Disputes', 'Field Partners', 9, TRUE),
  ('directory', 'App Registrations', 'Field Partners', 10, TRUE),
  ('companies', 'Companies', 'Business', 11, TRUE),
  ('amc', 'AMC Contracts', 'Business', 12, TRUE),
  ('finance', 'Finance & Payouts', 'Business', 13, TRUE),
  ('invoices', 'Invoices', 'Business', 14, TRUE),
  ('customer-panel', 'Customer Panel', 'Apps & Admin', 15, TRUE),
  ('partner-app', 'Partner App', 'Apps & Admin', 16, TRUE),
  ('users', 'Users & Roles', 'Apps & Admin', 17, TRUE),
  ('activity', 'Activity Log', 'Apps & Admin', 18, TRUE),
  ('settings', 'Settings', 'Apps & Admin', 19, TRUE)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_name = EXCLUDED.group_name,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active;

-- Workflow statuses (replaces PROJECT_STATUSES, MILESTONE_STATUSES, STAGE_TRANSITIONS)
CREATE TABLE IF NOT EXISTS superadmin.workflow_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type VARCHAR(30) NOT NULL,
  code VARCHAR(40) NOT NULL,
  label VARCHAR(100) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_statuses_unique UNIQUE (workflow_type, code)
);

-- Project statuses
INSERT INTO superadmin.workflow_statuses (workflow_type, code, label, sort_order, is_terminal) VALUES
  ('project', 'draft', 'Draft', 1, FALSE),
  ('project', 'submitted', 'Submitted', 2, FALSE),
  ('project', 'under_review', 'Under Review', 3, FALSE),
  ('project', 'clarification_required', 'Clarification Required', 4, FALSE),
  ('project', 'approved', 'Approved', 5, FALSE),
  ('project', 'in_progress', 'In Progress', 6, FALSE),
  ('project', 'completed', 'Completed', 7, TRUE),
  ('project', 'cancelled', 'Cancelled', 8, TRUE)
ON CONFLICT (workflow_type, code) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal;

-- Milestone statuses
INSERT INTO superadmin.workflow_statuses (workflow_type, code, label, sort_order, is_terminal) VALUES
  ('milestone', 'pending', 'Pending', 1, FALSE),
  ('milestone', 'in_progress', 'In Progress', 2, FALSE),
  ('milestone', 'completed', 'Completed', 3, TRUE),
  ('milestone', 'blocked', 'Blocked', 4, FALSE)
ON CONFLICT (workflow_type, code) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal;

-- Client sign-off statuses
INSERT INTO superadmin.workflow_statuses (workflow_type, code, label, sort_order, is_terminal) VALUES
  ('signoff', 'not_required', 'Not Required', 1, TRUE),
  ('signoff', 'pending', 'Pending', 2, FALSE),
  ('signoff', 'approved', 'Approved', 3, TRUE),
  ('signoff', 'rejected', 'Rejected', 4, TRUE)
ON CONFLICT (workflow_type, code) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal;

-- Repair stages
INSERT INTO superadmin.workflow_statuses (workflow_type, code, label, sort_order, is_terminal) VALUES
  ('repair_stage', 'received', 'Received', 1, FALSE),
  ('repair_stage', 'diagnosis', 'Diagnosis', 2, FALSE),
  ('repair_stage', 'quote_approval', 'Quote Approval', 3, FALSE),
  ('repair_stage', 'repairing', 'Repairing', 4, FALSE),
  ('repair_stage', 'qc_passed', 'QC Passed', 5, FALSE),
  ('repair_stage', 'delivered', 'Delivered', 6, TRUE)
ON CONFLICT (workflow_type, code) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal;

-- Repair stage transitions
CREATE TABLE IF NOT EXISTS superadmin.repair_stage_transitions (
  from_stage VARCHAR(40) NOT NULL,
  to_stage VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_stage, to_stage),
  CONSTRAINT repair_stage_transitions_from_fk FOREIGN KEY (from_stage) REFERENCES superadmin.workflow_statuses(code),
  CONSTRAINT repair_stage_transitions_to_fk FOREIGN KEY (to_stage) REFERENCES superadmin.workflow_statuses(code)
);

INSERT INTO superadmin.repair_stage_transitions (from_stage, to_stage) VALUES
  ('submitted', 'received'),
  ('received', 'diagnosis'),
  ('diagnosis', 'quote_approval'),
  ('approved', 'repairing'),
  ('repair_in_progress', 'qc_passed'),
  ('ready', 'delivered')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS superadmin_workflow_statuses_type_idx
  ON superadmin.workflow_statuses (workflow_type, sort_order);

CREATE INDEX IF NOT EXISTS superadmin_repair_stage_transitions_from_idx
  ON superadmin.repair_stage_transitions (from_stage);

GRANT ALL ON ALL TABLES IN SCHEMA superadmin TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA superadmin TO postgres;