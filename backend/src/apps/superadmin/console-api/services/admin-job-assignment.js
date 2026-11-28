const { db, nowIso } = require('../../../../db/energy_provider');
const JobModel = require('../../../../models/energy_provider/JobModel');
const UserModel = require('../../../../models/energy_provider/UserModel');
const {
  AuditLogModel,
  NotificationModel,
  StageHistoryModel,
  WorkflowStepModel,
} = require('../../../../models/energy_provider/MarketplaceModels');
const { FIELD_WORKFLOW_STEPS } = require('../../../../utils/energy_provider/constants');

class AssignmentError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AssignmentError';
    this.statusCode = statusCode;
  }
}

const isTrue = (value) => value === true || value === 1 || value === '1' || value === 'true';
const asId = (value) => value === null || value === undefined ? null : String(value);

function createAdminJobAssignmentService(dependencies = {}) {
  const database = dependencies.db || db;
  const jobs = dependencies.JobModel || JobModel;
  const users = dependencies.UserModel || UserModel;
  const workflowSteps = dependencies.WorkflowStepModel || WorkflowStepModel;
  const stageHistory = dependencies.StageHistoryModel || StageHistoryModel;
  const notifications = dependencies.NotificationModel || NotificationModel;
  const auditLogs = dependencies.AuditLogModel || AuditLogModel;
  const timestamp = dependencies.nowIso || nowIso;

  async function releasePartnerIfIdle(partnerId, jobId, handle) {
    const activeJobs = await handle.get(
      `SELECT COUNT(*) AS count
         FROM \`jobs\`
        WHERE \`assigned_partner_id\` = ?
          AND \`id\` <> ?
          AND \`status\` IN ('accepted', 'in_progress')`,
      [partnerId, jobId],
    );
    if (Number(activeJobs?.count || 0) === 0) {
      await handle.run(
        `UPDATE \`users\` SET \`is_busy\` = 0, \`updated_at\` = ? WHERE \`id\` = ?`,
        [timestamp(), partnerId],
      );
    }
  }

  async function assignJob(reference, partnerId, actor) {
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 120) {
      throw new AssignmentError('A valid job reference is required.', 400);
    }
    if (partnerId !== null && (typeof partnerId !== 'string' || !/^[1-9]\d*$/.test(partnerId))) {
      throw new AssignmentError('A valid partner ID is required.', 400);
    }

    return database.transaction(async (handle) => {
      let job = await jobs.findByReference(reference.trim(), handle);
      if (!job && /^[1-9]\d*$/.test(reference.trim())) {
        job = await jobs.findById(reference.trim(), handle);
      }
      if (!job) throw new AssignmentError('Job not found.', 404);
      const previousPartnerId = asId(job.assigned_partner_id);
      if (partnerId !== null && previousPartnerId === partnerId) {
        return {
          changed: false,
          jobId: String(job.id),
          reference: job.reference_id || String(job.id),
          partnerId,
        };
      }

      const firstStage = (jobs.STAGE_FLOWS[job.job_type] || jobs.STAGE_FLOWS.service)[0];
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'declined') {
        throw new AssignmentError('Completed or closed jobs cannot be dispatched.', 409);
      }
      if (previousPartnerId && (
        job.status !== 'accepted' ||
        (job.stage && job.stage !== firstStage)
      )) {
        throw new AssignmentError('A job cannot be reassigned after partner work has started.', 409);
      }

      if (partnerId === null) {
        if (!previousPartnerId) {
          return {
            changed: false,
            jobId: String(job.id),
            reference: job.reference_id || String(job.id),
            partnerId: null,
          };
        }
        const updatedAt = timestamp();
        const result = await handle.run(
          `UPDATE \`jobs\`
              SET \`assigned_partner_id\` = NULL, \`assigned_at\` = NULL,
                  \`status\` = 'open', \`stage\` = NULL, \`updated_at\` = ?
            WHERE \`id\` = ? AND \`status\` = 'accepted' AND \`assigned_partner_id\` = ?`,
          [updatedAt, job.id, previousPartnerId],
        );
        if (!result.affectedRows) throw new AssignmentError('Job changed while it was being unassigned. Refresh and retry.', 409);

        await releasePartnerIfIdle(previousPartnerId, job.id, handle);
        await stageHistory.create({
          jobId: job.id,
          fromStage: job.stage || firstStage,
          toStage: 'triage',
          actorId: null,
          note: `Returned to dispatch by ${actor.name}.`,
        }, handle);
        await notifications.create({
          partnerId: previousPartnerId,
          jobId: job.id,
          type: 'job_unassigned',
          title: 'Job returned to dispatch',
          body: `${job.reference_id || `Job ${job.id}`} is no longer assigned to you.`,
        }, handle);
        await auditLogs.create({
          actorId: null,
          entity: 'job',
          entityId: job.id,
          action: 'unassigned_by_superadmin',
          beforeState: { status: job.status, assignedPartnerId: previousPartnerId },
          afterState: { status: 'open', assignedPartnerId: null, superadminId: actor.id, superadminEmail: actor.email },
        }, handle);
        return {
          changed: true,
          jobId: String(job.id),
          reference: job.reference_id || String(job.id),
          partnerId: null,
        };
      }

      if (!['open', 'accepted'].includes(job.status)) {
        throw new AssignmentError('Only open or newly accepted jobs can be dispatched.', 409);
      }
      const partner = await users.findById(partnerId, handle);
      if (!partner) throw new AssignmentError('Partner not found.', 404);
      if (String(partner.role || '').toLowerCase() !== String(job.target_role || '').toLowerCase()) {
        throw new AssignmentError('The selected partner role does not match this job.', 409);
      }
      if (partner.status !== 'approved' || !isTrue(partner.is_online) || isTrue(partner.is_busy)) {
        throw new AssignmentError('Partner is not approved and available for dispatch.', 409);
      }

      const assignedAt = timestamp();
      const reserved = await handle.run(
        `UPDATE \`users\`
            SET \`is_busy\` = 1, \`updated_at\` = ?
          WHERE \`id\` = ? AND \`status\` = 'approved'
            AND \`is_online\` = 1 AND \`is_busy\` = 0`,
        [assignedAt, partnerId],
      );
      if (!reserved.affectedRows) throw new AssignmentError('Partner became unavailable. Refresh and choose another.', 409);

      const updateSql = previousPartnerId
        ? `UPDATE \`jobs\`
              SET \`assigned_partner_id\` = ?, \`assigned_at\` = ?,
                  \`status\` = 'accepted', \`stage\` = ?, \`updated_at\` = ?
            WHERE \`id\` = ? AND \`status\` = 'accepted' AND \`assigned_partner_id\` = ?`
        : `UPDATE \`jobs\`
              SET \`assigned_partner_id\` = ?, \`assigned_at\` = ?,
                  \`status\` = 'accepted', \`stage\` = ?, \`updated_at\` = ?
            WHERE \`id\` = ? AND \`status\` = 'open' AND \`assigned_partner_id\` IS NULL`;
      const updateParams = previousPartnerId
        ? [partnerId, assignedAt, firstStage, assignedAt, job.id, previousPartnerId]
        : [partnerId, assignedAt, firstStage, assignedAt, job.id];
      const updated = await handle.run(updateSql, updateParams);
      if (!updated.affectedRows) throw new AssignmentError('Job changed while it was being dispatched. Refresh and retry.', 409);

      if (job.job_type === 'service' && !(await workflowSteps.findByJob(job.id, handle)).length) {
        for (const step of FIELD_WORKFLOW_STEPS) {
          await workflowSteps.create({
            jobId: job.id,
            stepNumber: step.stepNumber,
            stepKey: step.stepKey,
            status: 'pending',
          }, handle);
        }
      }
      if (previousPartnerId) {
        await releasePartnerIfIdle(previousPartnerId, job.id, handle);
        await notifications.create({
          partnerId: previousPartnerId,
          jobId: job.id,
          type: 'job_unassigned',
          title: 'Job reassigned',
          body: `${job.reference_id || `Job ${job.id}`} is now assigned to ${partner.business_name || partner.full_name || 'another partner'}.`,
        }, handle);
      }
      await stageHistory.create({
        jobId: job.id,
        fromStage: job.stage || null,
        toStage: firstStage,
        actorId: null,
        note: `Dispatched to ${partner.business_name || partner.full_name || `partner ${partner.id}`} by ${actor.name}.`,
      }, handle);
      await notifications.create({
        partnerId,
        jobId: job.id,
        type: 'job_assigned',
        title: 'New job assigned',
        body: `${job.reference_id || `Job ${job.id}`} · ${job.title || 'Service job'}`,
      }, handle);
      await auditLogs.create({
        actorId: null,
        entity: 'job',
        entityId: job.id,
        action: previousPartnerId ? 'reassigned_by_superadmin' : 'assigned_by_superadmin',
        beforeState: { status: job.status, assignedPartnerId: previousPartnerId },
        afterState: {
          status: 'accepted',
          assignedPartnerId: partnerId,
          assignedAt,
          superadminId: actor.id,
          superadminEmail: actor.email,
        },
      }, handle);

      return {
        changed: true,
        jobId: String(job.id),
        reference: job.reference_id || String(job.id),
        partnerId,
        partnerName: partner.business_name || partner.full_name || `Partner ${partner.id}`,
        assignedAt,
      };
    });
  }

  return { assignJob };
}

module.exports = { createAdminJobAssignmentService, AssignmentError };
