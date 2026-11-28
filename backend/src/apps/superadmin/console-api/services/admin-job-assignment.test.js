const assert = require('node:assert/strict');
const test = require('node:test');
const JobModel = require('../../../../models/energy_provider/JobModel');
const { createAdminJobAssignmentService } = require('./admin-job-assignment');

function assignmentHarness({ jobOverrides = {}, partnerOverrides = {}, jobUpdateCount = 1 } = {}) {
  const job = {
    id: 41,
    reference_id: 'JOB-41',
    job_type: 'service',
    target_role: 'service_partner',
    title: 'Inverter inspection',
    status: 'open',
    stage: null,
    assigned_partner_id: null,
    ...jobOverrides,
  };
  const partner = {
    id: 17,
    role: 'service_partner',
    status: 'approved',
    is_online: true,
    is_busy: false,
    full_name: 'Asha Sharma',
    business_name: 'Asha Electricals',
    ...partnerOverrides,
  };
  const records = { stages: [], notifications: [], audits: [], workflow: [] };
  let busy = Boolean(partner.is_busy);
  const handle = {
    async run(sql, params) {
      if (sql.includes('UPDATE `users`') && sql.includes('`is_busy` = 1')) {
        if (busy) return { affectedRows: 0 };
        busy = true;
        return { affectedRows: 1 };
      }
      if (sql.includes('UPDATE `jobs`') && sql.includes('`assigned_partner_id` = NULL')) {
        job.assigned_partner_id = null;
        job.assigned_at = null;
        job.status = 'open';
        job.stage = null;
        return { affectedRows: 1 };
      }
      if (sql.includes('UPDATE `jobs`')) {
        if (!jobUpdateCount) return { affectedRows: 0 };
        job.assigned_partner_id = params[0] ?? null;
        job.assigned_at = params[1] ?? null;
        job.status = job.assigned_partner_id ? 'accepted' : 'open';
        job.stage = job.assigned_partner_id ? params[2] ?? null : null;
        return { affectedRows: 1 };
      }
      if (sql.includes('UPDATE `users`') && sql.includes('`is_busy` = 0')) {
        busy = false;
        return { affectedRows: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async get(sql) {
      if (sql.includes('COUNT(*)')) return { count: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const service = createAdminJobAssignmentService({
    db: {
      async transaction(callback) {
        const previousBusy = busy;
        try {
          return await callback(handle);
        } catch (error) {
          busy = previousBusy;
          throw error;
        }
      },
    },
    JobModel: {
      ...JobModel,
      findByReference: async () => job,
      findById: async () => job,
    },
    UserModel: { findById: async () => partner },
    WorkflowStepModel: {
      findByJob: async () => [],
      create: async (step) => records.workflow.push(step),
    },
    StageHistoryModel: { create: async (entry) => records.stages.push(entry) },
    NotificationModel: { create: async (entry) => records.notifications.push(entry) },
    AuditLogModel: { create: async (entry) => records.audits.push(entry) },
    nowIso: () => '2026-03-01T10:00:00.000Z',
  });
  return { service, job, partner, records, isBusy: () => busy };
}

test('superadmin dispatch persists the assignment and records partner-facing and audit activity', async () => {
  const harness = assignmentHarness();

  const result = await harness.service.assignJob('JOB-41', '17', {
    id: 'admin-1',
    email: 'root@example.test',
    name: 'Root Admin',
  });

  assert.equal(result.changed, true);
  assert.equal(result.partnerId, '17');
  assert.equal(harness.job.assigned_partner_id, '17');
  assert.equal(harness.job.status, 'accepted');
  assert.equal(harness.job.assigned_at, '2026-03-01T10:00:00.000Z');
  assert.equal(harness.isBusy(), true);
  assert.equal(harness.records.notifications[0].type, 'job_assigned');
  assert.equal(harness.records.stages[0].toStage, 'accepted');
  assert.equal(harness.records.audits[0].action, 'assigned_by_superadmin');
  assert.equal(harness.records.audits[0].afterState.superadminId, 'admin-1');
  assert.equal(harness.records.workflow.length, 5);
});

test('superadmin dispatch rejects a role mismatch without changing partner availability', async () => {
  const harness = assignmentHarness({ partnerOverrides: { role: 'repairing_partner' } });

  await assert.rejects(
    harness.service.assignJob('JOB-41', '17', { id: 'admin-1', email: 'root@example.test', name: 'Root Admin' }),
    { statusCode: 409 },
  );
  assert.equal(harness.isBusy(), false);
  assert.equal(harness.records.notifications.length, 0);
});

test('superadmin dispatch reports an atomic job conflict and emits no success activity', async () => {
  const harness = assignmentHarness({ jobUpdateCount: 0 });

  await assert.rejects(
    harness.service.assignJob('JOB-41', '17', { id: 'admin-1', email: 'root@example.test', name: 'Root Admin' }),
    { statusCode: 409 },
  );
  assert.equal(harness.records.notifications.length, 0);
  assert.equal(harness.records.audits.length, 0);
  assert.equal(harness.isBusy(), false);
});

test('superadmin can return a newly assigned job to the queue and release an idle partner', async () => {
  const harness = assignmentHarness({
    jobOverrides: { status: 'accepted', stage: 'accepted', assigned_partner_id: '17' },
    partnerOverrides: { is_busy: true },
  });

  const result = await harness.service.assignJob('JOB-41', null, {
    id: 'admin-1',
    email: 'root@example.test',
    name: 'Root Admin',
  });

  assert.equal(result.changed, true);
  assert.equal(harness.job.status, 'open');
  assert.equal(harness.job.assigned_partner_id, null);
  assert.equal(harness.isBusy(), false);
  assert.equal(harness.records.notifications[0].type, 'job_unassigned');
  assert.equal(harness.records.audits[0].action, 'unassigned_by_superadmin');
});
