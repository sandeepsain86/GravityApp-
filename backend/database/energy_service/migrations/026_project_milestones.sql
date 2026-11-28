CREATE TABLE IF NOT EXISTS project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_request_id UUID NOT NULL REFERENCES project_requests (id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  sequence INTEGER NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  planned_start DATE,
  due_date DATE NOT NULL,
  completed_at TIMESTAMPTZ,
  client_signoff_status VARCHAR(24) NOT NULL DEFAULT 'not_required',
  lead_engineer_name VARCHAR(120),
  budget_amount NUMERIC(14,2),
  material_cost NUMERIC(14,2),
  partner_payout NUMERIC(14,2),
  billed_amount NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_milestones_title_check CHECK (char_length(btrim(title)) >= 2),
  CONSTRAINT project_milestones_sequence_check CHECK (sequence > 0),
  CONSTRAINT project_milestones_status_check CHECK (
    status IN ('pending', 'in_progress', 'completed', 'blocked')
  ),
  CONSTRAINT project_milestones_signoff_check CHECK (
    client_signoff_status IN ('not_required', 'pending', 'approved', 'rejected')
  ),
  CONSTRAINT project_milestones_date_range_check CHECK (
    planned_start IS NULL OR planned_start <= due_date
  ),
  CONSTRAINT project_milestones_amounts_check CHECK (
    (budget_amount IS NULL OR budget_amount >= 0) AND
    (material_cost IS NULL OR material_cost >= 0) AND
    (partner_payout IS NULL OR partner_payout >= 0) AND
    (billed_amount IS NULL OR billed_amount >= 0)
  ),
  CONSTRAINT project_milestones_project_sequence_unique UNIQUE (project_request_id, sequence)
);

CREATE INDEX IF NOT EXISTS project_milestones_project_schedule_idx
  ON project_milestones (project_request_id, due_date, sequence);

DROP TRIGGER IF EXISTS project_milestones_set_updated_at ON project_milestones;
CREATE TRIGGER project_milestones_set_updated_at
  BEFORE UPDATE ON project_milestones
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
