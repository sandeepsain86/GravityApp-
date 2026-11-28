/**
 * Job acceptance / decline service.
 *
 * Acceptance is a transaction:
 *  1. lock the partner into "busy" so no second offer reaches them
 *  2. claim the job with a conditional UPDATE (`status = 'open'`)
 *  3. seed the five step field workflow
 *  4. write stage history, partner response and audit log
 *
 * Because step 2 is a conditional UPDATE, exactly one partner wins a job even
 * if several accept it simultaneously - the losers see affectedRows === 0.
 */

const { db, nowIso } = require('../../db/energy_provider/index');
const UserModel = require('../../models/energy_provider/UserModel');
const JobModel = require('../../models/energy_provider/JobModel');
const JobCoreService = require('./jobCoreService');
const { PartnerResponseModel, NotificationModel, AuditLogModel } =
  require('../../models/energy_provider/MarketplaceModels');
const { ApiError, maskPhone } = require('../../utils/energy_provider/apiError');
const { FIELD_WORKFLOW_STEPS } = require('../../utils/energy_provider/constants');

const JobAcceptService = {
  /** Accept a job for the authenticated partner. */
  async acceptJob(user, jobId) {
    const job = await JobModel.findById(jobId);
    if (!job) throw ApiError.notFound('Job not found');
    if (job.job_type === 'delivery') {
      throw ApiError.badRequest('Use the delivery acceptance workflow for delivery jobs');
    }
    if (job.status !== 'open') {
      throw ApiError.conflict('This job has already been taken');
    }
    if (job.target_role !== user.role) {
      throw ApiError.forbidden('This job is not published to your marketplace');
    }
    const eligibleJobs = await JobCoreService.listOpenJobs(user);
    if (!eligibleJobs.some((eligible) => String(eligible.id) === String(job.id))) {
      throw ApiError.forbidden('This job does not match your approved expertise');
    }
    if (!user.is_online) {
      throw ApiError.badRequest('Go online to accept jobs');
    }
    if (user.is_busy) {
      throw ApiError.conflict('You already have an active job. Complete it first.');
    }

    const firstStage = (JobModel.STAGE_FLOWS[job.job_type] || JobModel.STAGE_FLOWS.service)[0];

    try {
      await db.transaction(async (handle) => {
        const busy = await handle.run(
          `UPDATE \`users\` SET \`is_busy\` = 1, \`updated_at\` = ?
            WHERE \`id\` = ? AND \`is_busy\` = 0 AND \`is_online\` = 1`,
          [nowIso(), user.id]
        );
        if (!busy.affectedRows) {
          throw ApiError.conflict('You already have an active job. Complete it first.');
        }

        const assignedAt = nowIso();
        const result = await handle.run(
          `UPDATE \`jobs\`
              SET \`status\` = 'accepted',
                  \`assigned_partner_id\` = ?,
                  \`stage\` = ?,
                  \`assigned_at\` = ?,
                  \`updated_at\` = ?
            WHERE \`id\` = ? AND \`status\` = 'open' AND \`assigned_partner_id\` IS NULL`,
          [user.id, firstStage, assignedAt, assignedAt, job.id]
        );
        if (!result.affectedRows) {
          throw ApiError.conflict('This job has already been taken');
        }

        // Seed the five step field workflow for service style jobs.
        if (job.job_type === 'service') {
          for (const step of FIELD_WORKFLOW_STEPS) {
            await handle.run(
              `INSERT INTO \`job_workflow_steps\`
                 (\`job_id\`, \`step_number\`, \`step_key\`, \`status\`, \`created_at\`, \`updated_at\`)
               VALUES (?, ?, ?, 'pending', ?, ?)`,
              [job.id, step.stepNumber, step.stepKey, nowIso(), nowIso()]
            );
          }
        }

        await handle.run(
          `INSERT INTO \`job_stage_history\`
             (\`job_id\`, \`from_stage\`, \`to_stage\`, \`actor_id\`, \`note\`, \`created_at\`)
           VALUES (?, NULL, ?, ?, ?, ?)`,
          [job.id, firstStage, user.id, 'Job accepted by partner', nowIso()]
        );

        // A declined offer can be flipped to accepted — use upsert semantics
        // against the unique (job_id, partner_id) index.
        await handle.run(
          db.driver === 'postgres'
            ? `INSERT INTO job_partner_responses (job_id, partner_id, response, created_at)
               VALUES (?, ?, 'accepted', ?)
               ON CONFLICT (job_id, partner_id) DO UPDATE SET response = 'accepted', decline_reason = NULL, created_at = EXCLUDED.created_at`
            : db.driver === 'mysql'
              ? `INSERT INTO job_partner_responses (job_id, partner_id, response, created_at)
                 VALUES (?, ?, 'accepted', ?)
                 ON DUPLICATE KEY UPDATE response = 'accepted', decline_reason = NULL, created_at = VALUES(created_at)`
              : `INSERT INTO job_partner_responses (job_id, partner_id, response, created_at)
                 VALUES (?, ?, 'accepted', ?)
                 ON CONFLICT(job_id, partner_id) DO UPDATE SET response = 'accepted', decline_reason = NULL, created_at = excluded.created_at`,
          [job.id, user.id, nowIso()]
        );
      });
    } catch (err) {
      // The transaction rolled back, so release the busy flag again.
      if (err instanceof ApiError) {
        await UserModel.setBusy(user.id, false);
      }
      throw err;
    }

    await NotificationModel.create({
      partnerId: user.id,
      jobId: job.id,
      type: 'job_accepted',
      title: `Job ${job.reference_id} accepted`,
      body: job.title,
    });

    await AuditLogModel.create({
      actorId: user.id,
      entity: 'job',
      entityId: job.id,
      action: 'accepted',
      beforeState: { status: 'open' },
      afterState: { status: 'accepted', assignedPartnerId: user.id },
    });

    const updated = await JobModel.findById(job.id);
    return {
      ...JobModel.toApi(updated, { includePii: true }),
      customerPhoneMasked: maskPhone(updated.customer_phone),
    };
  },

  /** Decline a job - the offer is not shown to this partner again. */
  async declineJob(user, jobId, { reason } = {}) {
    const job = await JobModel.findById(jobId);
    if (!job) throw ApiError.notFound('Job not found');
    if (job.target_role !== user.role) {
      throw ApiError.forbidden('This job is not published to your marketplace');
    }

    const existing = await PartnerResponseModel.findByJob(job.id);
    const already = existing.find((row) => String(row.partner_id) === String(user.id));
    if (already) {
      await PartnerResponseModel.updateById(already.id, {
        response: 'declined',
        declineReason: reason || already.decline_reason,
      });
    } else {
      await PartnerResponseModel.create({
        jobId: job.id,
        partnerId: user.id,
        response: 'declined',
        declineReason: reason || '',
      });
    }

    await AuditLogModel.create({
      actorId: user.id,
      entity: 'job',
      entityId: job.id,
      action: 'declined',
      afterState: { reason: reason || '' },
    });

    return { jobId: job.id, referenceId: job.reference_id, response: 'declined' };
  },
};

module.exports = JobAcceptService;
