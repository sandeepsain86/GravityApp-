const { assertStatusChange } = require('../../../../domain/energy_service/customerStatus');
const { pool } = require('../../../../config/energy_service/db');

const DEFAULT_PROJECT_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'clarification_required',
  'approved',
  'in_progress',
  'completed',
  'cancelled',
];

const DEFAULT_MILESTONE_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'];
const DEFAULT_SIGNOFF_STATUSES = ['not_required', 'pending', 'approved', 'rejected'];
const DEFAULT_MILESTONE_TRANSITIONS = {
  pending: ['in_progress', 'blocked'],
  in_progress: ['completed', 'blocked'],
  blocked: ['in_progress'],
  completed: [],
};

let projectStatusesCache = null;
let milestoneStatusesCache = null;
let signoffStatusesCache = null;
let milestoneTransitionsCache = null;
let statusesCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Local references for internal synchronous access (initialized from defaults)
let PROJECT_STATUSES = [...DEFAULT_PROJECT_STATUSES];
let MILESTONE_STATUSES = [...DEFAULT_MILESTONE_STATUSES];
let SIGNOFF_STATUSES = [...DEFAULT_SIGNOFF_STATUSES];
let MILESTONE_TRANSITIONS = { ...DEFAULT_MILESTONE_TRANSITIONS };

async function loadWorkflowStatuses() {
  const now = Date.now();
  if (projectStatusesCache && now - statusesCacheTime < CACHE_TTL_MS) {
    PROJECT_STATUSES = projectStatusesCache;
    MILESTONE_STATUSES = milestoneStatusesCache;
    SIGNOFF_STATUSES = signoffStatusesCache;
    MILESTONE_TRANSITIONS = milestoneTransitionsCache;
    return {
      PROJECT_STATUSES,
      MILESTONE_STATUSES,
      SIGNOFF_STATUSES,
      MILESTONE_TRANSITIONS,
    };
  }
  try {
    const [projectRows, milestoneRows, signoffRows] = await Promise.all([
      pool.query(
        `SELECT code FROM superadmin.workflow_statuses WHERE workflow_type = 'project' ORDER BY sort_order ASC`
      ),
      pool.query(
        `SELECT code FROM superadmin.workflow_statuses WHERE workflow_type = 'milestone' ORDER BY sort_order ASC`
      ),
      pool.query(
        `SELECT code FROM superadmin.workflow_statuses WHERE workflow_type = 'signoff' ORDER BY sort_order ASC`
      ),
    ]);

    if (projectRows.rows.length > 0) {
      projectStatusesCache = projectRows.rows.map(r => r.code);
    }
    if (milestoneRows.rows.length > 0) {
      milestoneStatusesCache = milestoneRows.rows.map(r => r.code);
    }
    if (signoffRows.rows.length > 0) {
      signoffStatusesCache = signoffRows.rows.map(r => r.code);
    }
    statusesCacheTime = now;

    PROJECT_STATUSES = projectStatusesCache || DEFAULT_PROJECT_STATUSES;
    MILESTONE_STATUSES = milestoneStatusesCache || DEFAULT_MILESTONE_STATUSES;
    SIGNOFF_STATUSES = signoffStatusesCache || DEFAULT_SIGNOFF_STATUSES;
    MILESTONE_TRANSITIONS = milestoneTransitionsCache || DEFAULT_MILESTONE_TRANSITIONS;
  } catch (error) {
    // Fall back to defaults
    PROJECT_STATUSES = [...DEFAULT_PROJECT_STATUSES];
    MILESTONE_STATUSES = [...DEFAULT_MILESTONE_STATUSES];
    SIGNOFF_STATUSES = [...DEFAULT_SIGNOFF_STATUSES];
    MILESTONE_TRANSITIONS = { ...DEFAULT_MILESTONE_TRANSITIONS };
  }

  return {
    PROJECT_STATUSES,
    MILESTONE_STATUSES,
    SIGNOFF_STATUSES,
    MILESTONE_TRANSITIONS,
  };
}

function workflowError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateMilestone(input, partial = false) {
  const allowed = [
    'title',
    'status',
    'plannedStart',
    'dueDate',
    'clientSignoffStatus',
    'leadEngineerName',
    'budgetAmount',
    'materialCost',
    'partnerPayout',
    'billedAmount',
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      (!partial && !Object.prototype.hasOwnProperty.call(input, 'title')) ||
      (!partial && !Object.prototype.hasOwnProperty.call(input, 'dueDate'))) {
    throw workflowError('Milestone details are invalid.', 400);
  }
  if (input.title !== undefined &&
      (typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.length > 160)) {
    throw workflowError('Milestone name must be between 2 and 160 characters.', 400);
  }
  if (input.status !== undefined && !MILESTONE_STATUSES.includes(input.status)) {
    throw workflowError('Choose a valid milestone status.', 400);
  }
  if (input.clientSignoffStatus !== undefined && !SIGNOFF_STATUSES.includes(input.clientSignoffStatus)) {
    throw workflowError('Choose a valid client sign-off status.', 400);
  }
  if (input.dueDate !== undefined && !validDate(input.dueDate)) {
    throw workflowError('Milestone due date must be a valid calendar date.', 400);
  }
  if (input.plannedStart !== undefined &&
      input.plannedStart !== null && !validDate(input.plannedStart)) {
    throw workflowError('Milestone start date must be a valid calendar date.', 400);
  }
  if (input.plannedStart && input.dueDate && input.plannedStart > input.dueDate) {
    throw workflowError('Milestone start date cannot be after its due date.', 400);
  }
  if (input.leadEngineerName !== undefined &&
      (input.leadEngineerName !== null &&
        (typeof input.leadEngineerName !== 'string' || input.leadEngineerName.trim().length > 120))) {
    throw workflowError('Lead engineer name must be 120 characters or fewer.', 400);
  }
  for (const key of ['budgetAmount', 'materialCost', 'partnerPayout', 'billedAmount']) {
    if (input[key] !== undefined && input[key] !== null &&
        (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0)) {
      throw workflowError(`${key} must be a non-negative number.`, 400);
    }
  }
}

function createAdminProjectWorkflow(pool) {
  return {
    async transitionStatus(reference, targetStatus, note, actor) {
      if (!PROJECT_STATUSES.includes(targetStatus)) {
        throw workflowError('Choose a valid project status.', 400);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT id, request_number, status
             FROM public.project_requests
            WHERE id::text = $1 OR request_number = $1
            FOR UPDATE`,
          [reference],
        );
        const project = selected.rows[0];
        if (!project) throw workflowError('The project request was not found.', 404);
        try {
          assertStatusChange('project_request', project.status, targetStatus, 'manage');
        } catch (error) {
          throw workflowError(error.message, error.statusCode || 409);
        }
        if (targetStatus === 'completed') {
          const incomplete = await client.query(
            `SELECT COUNT(*)::int AS count
               FROM public.project_milestones
              WHERE project_request_id = $1
                AND (
                  status <> 'completed' OR
                  client_signoff_status IN ('pending', 'rejected')
                )`,
            [project.id],
          );
          if (Number(incomplete.rows[0]?.count || 0) > 0) {
            throw workflowError('Complete all milestones and resolve client sign-offs before closing this project.', 409);
          }
        }

        const updated = await client.query(
          `UPDATE public.project_requests
              SET status = $2,
                  submitted_at = CASE WHEN $2 = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
                  completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
                  cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, request_number, status, updated_at`,
          [project.id, targetStatus],
        );
        const remarks = [
          note ? note.trim() : '',
          `Updated by Superadmin ${actor.name} (${actor.email}).`,
        ].filter(Boolean).join('\n');
        await client.query(
          `INSERT INTO public.project_status_history
             (project_request_id, old_status, new_status, changed_by, remarks)
           VALUES ($1, $2, $3, NULL, $4)`,
          [project.id, project.status, targetStatus, remarks],
        );
        await client.query('COMMIT');
        return updated.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async createMilestone(reference, input, actor) {
      validateMilestone(input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT id, request_number, status
             FROM public.project_requests
            WHERE id::text = $1 OR request_number = $1
            FOR UPDATE`,
          [reference],
        );
        const project = selected.rows[0];
        if (!project) throw workflowError('The project request was not found.', 404);
        if (['completed', 'cancelled'].includes(project.status)) {
          throw workflowError('Milestones cannot be added to a closed project.', 409);
        }
        const result = await client.query(
          `INSERT INTO public.project_milestones
             (project_request_id, title, sequence, status, planned_start, due_date,
              client_signoff_status, lead_engineer_name, budget_amount, material_cost,
              partner_payout, billed_amount)
           VALUES (
             $1, $2,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM public.project_milestones WHERE project_request_id = $1),
             'pending', $3, $4, $5, $6, $7, $8, $9, $10
           )
           RETURNING *`,
          [
            project.id,
            input.title.trim(),
            input.plannedStart || null,
            input.dueDate,
            input.clientSignoffStatus || 'not_required',
            input.leadEngineerName ? input.leadEngineerName.trim() : null,
            input.budgetAmount ?? null,
            input.materialCost ?? null,
            input.partnerPayout ?? null,
            input.billedAmount ?? null,
          ],
        );
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async updateMilestone(reference, milestoneId, input) {
      validateMilestone(input, true);
      if (!Object.keys(input).length) throw workflowError('Provide at least one milestone field to update.', 400);
      const fields = {
        title: ['title', (value) => value.trim()],
        status: ['status', (value) => value],
        plannedStart: ['planned_start', (value) => value],
        dueDate: ['due_date', (value) => value],
        clientSignoffStatus: ['client_signoff_status', (value) => value],
        leadEngineerName: ['lead_engineer_name', (value) => value ? value.trim() : null],
        budgetAmount: ['budget_amount', (value) => value],
        materialCost: ['material_cost', (value) => value],
        partnerPayout: ['partner_payout', (value) => value],
        billedAmount: ['billed_amount', (value) => value],
      };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT milestone.*, project.status AS project_status
             FROM public.project_milestones milestone
             JOIN public.project_requests project ON project.id = milestone.project_request_id
            WHERE milestone.id::text = $1
              AND (project.id::text = $2 OR project.request_number = $2)
            FOR UPDATE OF project, milestone`,
          [milestoneId, reference],
        );
        const existing = selected.rows[0];
        if (!existing) throw workflowError('The project milestone was not found.', 404);
        if (['completed', 'cancelled'].includes(existing.project_status)) {
          throw workflowError('Milestones cannot be changed after a project is closed.', 409);
        }
        if (input.status !== undefined && input.status !== existing.status &&
            !MILESTONE_TRANSITIONS[existing.status]?.includes(input.status)) {
          throw workflowError('That milestone status change is not allowed.', 409);
        }
        const merged = {
          title: existing.title,
          status: existing.status,
          plannedStart: existing.planned_start,
          dueDate: existing.due_date,
          clientSignoffStatus: existing.client_signoff_status,
          leadEngineerName: existing.lead_engineer_name,
          budgetAmount: optionalAmount(existing.budget_amount),
          materialCost: optionalAmount(existing.material_cost),
          partnerPayout: optionalAmount(existing.partner_payout),
          billedAmount: optionalAmount(existing.billed_amount),
          ...input,
        };
        validateMilestone(merged);

        const entries = Object.entries(input);
        const assignments = entries.map(([key], index) => `${fields[key][0]} = $${index + 2}`);
        const values = entries.map(([key, value]) => fields[key][1](value));
        const result = await client.query(
          `UPDATE public.project_milestones
              SET ${assignments.join(', ')}, updated_at = NOW(),
                  completed_at = CASE
                    WHEN $${entries.length + 2} = 'completed' THEN COALESCE(completed_at, NOW())
                    WHEN $${entries.length + 2} = 'pending' THEN NULL
                    ELSE completed_at
                  END
            WHERE id = $1
            RETURNING *`,
          [existing.id, ...values, input.status ?? existing.status],
        );
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function optionalAmount(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  createAdminProjectWorkflow,
  loadWorkflowStatuses,
  get PROJECT_STATUSES() { return projectStatusesCache || DEFAULT_PROJECT_STATUSES; },
  get MILESTONE_STATUSES() { return milestoneStatusesCache || DEFAULT_MILESTONE_STATUSES; },
  get SIGNOFF_STATUSES() { return signoffStatusesCache || DEFAULT_SIGNOFF_STATUSES; },
  get MILESTONE_TRANSITIONS() { return milestoneTransitionsCache || DEFAULT_MILESTONE_TRANSITIONS; },
  DEFAULT_PROJECT_STATUSES,
  DEFAULT_MILESTONE_STATUSES,
  DEFAULT_SIGNOFF_STATUSES,
  DEFAULT_MILESTONE_TRANSITIONS,
};
