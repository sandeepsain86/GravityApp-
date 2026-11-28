/**
 * Delivery service - pickup to workshop workflow.
 *
 * A delivery job moves: pickup -> to_workshop -> delivered.
 * Each leg needs an arrival confirmation AND a photo, so the evidence chain
 * required by the documentation is enforced server side.
 */

const { db, nowIso } = require('../../db/energy_provider/index');
const JobModel = require('../../models/energy_provider/JobModel');
const UserModel = require('../../models/energy_provider/UserModel');
const RegistrationModel = require('../../models/energy_provider/RegistrationModel');
const {
  PhotoModel,
  StageHistoryModel,
  NotificationModel,
  AuditLogModel,
  DeliveryVerificationModel,
} =
  require('../../models/energy_provider/MarketplaceModels');
const { ApiError, maskPhone } = require('../../utils/energy_provider/apiError');

const DELIVERY_STAGES = ['pickup', 'to_workshop', 'delivered'];

const requireVerifiedPartner = async (user) => {
  if (!user || user.role !== 'service_partner') {
    throw ApiError.forbidden('Only service partners can access delivery requests');
  }

  const verification = await DeliveryVerificationModel.findByUser(user.id);
  if (!verification || verification.status !== 'approved') {
    throw ApiError.forbidden(
      verification?.status === 'pending'
        ? 'Delivery partner verification is pending approval'
        : 'Complete delivery partner verification before accessing delivery requests'
    );
  }
};

const toPartnerApi = (job) => ({
  ...JobModel.toApi(job, { includePii: true }),
  customerPhoneMasked: maskPhone(job.customer_phone),
});

const DeliveryService = {
  DELIVERY_STAGES,

  /** Open delivery requests. */
  async listOpenJobs(user) {
    await requireVerifiedPartner(user);
    const jobs = await JobModel.findOpenDelivery();
    return jobs.map(toPartnerApi);
  },

  /** Accept a delivery job (same atomic claim as the service marketplace). */
  async acceptJob(user, jobId) {
    await requireVerifiedPartner(user);
    const job = await JobModel.findById(jobId);
    if (!job) throw ApiError.notFound('Delivery job not found');
    if (job.job_type !== 'delivery') {
      throw ApiError.badRequest('This is not a delivery job');
    }
    if (job.status !== 'open') {
      throw ApiError.conflict('This delivery job has already been taken');
    }
    const roleApplications = await RegistrationModel.findByMobile(user.mobile);
    const application = roleApplications.find((record) => record.partner_role === user.role && record.status !== 'draft')
      || await RegistrationModel.findLatestByUserAndRole(user.id, user.role);
    if (user.specialization_status === 'pending' || user.specialization_status === 'rejected') {
      throw ApiError.forbidden('Your expertise selection must be approved before accepting matched work');
    }
    const rawSpecializations = application?.specializations || {};
    const decodedSpecializations = typeof rawSpecializations === 'string' ? JSON.parse(rawSpecializations) : rawSpecializations;
    const nestedSpecializations = decodedSpecializations.specializations && typeof decodedSpecializations.specializations === 'object'
      ? decodedSpecializations.specializations
      : decodedSpecializations;
    const submittedCategories = nestedSpecializations.categories || nestedSpecializations;
    const hasSelection = Object.keys(submittedCategories).some((key) => !['approvalStatus', 'submittedAt', 'reviewedAt', 'reviewedBy', 'reviewReason'].includes(key));
    if (hasSelection && (nestedSpecializations.approvalStatus || application?.specialization_status || user.specialization_status) !== 'approved') {
      throw ApiError.forbidden('Your selected expertise must be approved before accepting matching jobs');
    }
    if (!user.is_online) {
      throw ApiError.badRequest('Go online to accept delivery jobs');
    }
    if (user.is_busy) {
      throw ApiError.conflict('You already have an active job. Complete it first.');
    }

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
        const claimed = await handle.run(
          `UPDATE \`jobs\`
              SET \`status\` = 'accepted', \`assigned_partner_id\` = ?, \`stage\` = 'pickup',
                  \`assigned_at\` = ?, \`updated_at\` = ?
            WHERE \`id\` = ? AND \`status\` = 'open' AND \`assigned_partner_id\` IS NULL`,
          [user.id, assignedAt, assignedAt, job.id]
        );
        if (!claimed.affectedRows) {
          throw ApiError.conflict('This delivery job has already been taken');
        }

        await handle.run(
          `INSERT INTO \`job_stage_history\`
             (\`job_id\`, \`from_stage\`, \`to_stage\`, \`actor_id\`, \`note\`, \`created_at\`)
           VALUES (?, NULL, 'pickup', ?, 'Delivery job accepted', ?)`,
          [job.id, user.id, nowIso()]
        );
      });
    } catch (err) {
      if (err instanceof ApiError) {
        await UserModel.setBusy(user.id, false);
      }
      throw err;
    }

    await AuditLogModel.create({
      actorId: user.id,
      entity: 'job',
      entityId: job.id,
      action: 'delivery_accepted',
      afterState: { status: 'accepted' },
    });

    const updated = await JobModel.findById(job.id);
    return toPartnerApi(updated);
  },

  /**
   * Confirm arrival on a leg.  A photo is mandatory for the leg.
   */
  async confirmArrival(user, jobId, { leg, photo, fileName, fileRef } = {}) {
    const job = await JobModel.findById(jobId);
    if (!job) throw ApiError.notFound('Delivery job not found');
    if (String(job.assigned_partner_id) !== String(user.id)) {
      throw ApiError.forbidden('You are not assigned to this delivery job');
    }

    const legStage = leg === 'drop' ? 'to_workshop' : 'pickup';
    if (job.stage !== legStage) {
      throw ApiError.conflict(`Cannot confirm ${leg} at stage "${job.stage}"`);
    }
    if (!photo) {
      throw ApiError.badRequest(`A ${leg} photo is required to confirm arrival`);
    }

    await PhotoModel.create({
      jobId: job.id,
      photoType: leg === 'drop' ? 'drop' : 'pickup',
      fileName: fileName || `${leg}-photo`,
      fileRef: fileRef || photo,
    });

    const nextStage = leg === 'pickup' ? 'to_workshop' : 'delivered';
    await JobModel.updateById(job.id, { stage: nextStage });
    await StageHistoryModel.create({
      jobId: job.id,
      fromStage: legStage,
      toStage: nextStage,
      actorId: user.id,
      note: `Confirmed ${leg}`,
    });

    return { jobId: job.id, stage: nextStage, confirmedLeg: leg };
  },

  /** Mark the delivery as completed and credit the delivery earnings. */
  async completeDelivery(user, jobId) {
    const job = await JobModel.findById(jobId);
    if (!job) throw ApiError.notFound('Delivery job not found');
    if (String(job.assigned_partner_id) !== String(user.id)) {
      throw ApiError.forbidden('You are not assigned to this delivery job');
    }
    if (job.status === 'completed') {
      throw ApiError.conflict('This delivery is already completed');
    }

    const photos = await PhotoModel.findByJob(job.id);
    const hasPickup = photos.some((photo) => photo.photo_type === 'pickup');
    const hasDrop = photos.some((photo) => photo.photo_type === 'drop');
    if (!hasPickup || !hasDrop) {
      throw ApiError.badRequest('Pickup and drop photos are required to complete the delivery');
    }

    // The drop confirmation moves the job to `delivered`; it can only be
    // completed once both legs have been evidenced.
    if (job.stage !== 'delivered') {
      throw ApiError.conflict('Confirm the drop before marking the delivery complete');
    }

    const fee = Number(job.base_pay || 0);
    const commission = Math.round(fee * 0.1 * 100) / 100;
    const payout = Math.round((fee - commission) * 100) / 100;

    await db.transaction(async (handle) => {
      const result = await handle.run(
        `UPDATE \`jobs\`
            SET \`status\` = 'completed', \`stage\` = 'delivered',
                \`total_bill\` = ?, \`payout_amount\` = ?, \`completed_at\` = ?, \`updated_at\` = ?
          WHERE \`id\` = ? AND \`status\` != 'completed'`,
        [fee, payout, nowIso(), nowIso(), job.id]
      );
      if (!result.affectedRows) {
        throw ApiError.conflict('This delivery is already completed');
      }

      await handle.run(
        `INSERT INTO \`earnings\`
           (\`partner_id\`, \`job_id\`, \`source\`, \`gross_amount\`, \`commission\`,
            \`deductions\`, \`net_amount\`, \`status\`, \`created_at\`)
         VALUES (?, ?, 'delivery', ?, ?, 0, ?, 'pending', ?)`,
        [user.id, job.id, fee, commission, payout, nowIso()]
      );

      await handle.run(
        `UPDATE \`users\`
            SET \`is_busy\` = 0, \`jobs_completed\` = \`jobs_completed\` + 1, \`updated_at\` = ?
          WHERE \`id\` = ?`,
        [nowIso(), user.id]
      );
    });

    await NotificationModel.create({
      partnerId: user.id,
      jobId: job.id,
      type: 'delivery_completed',
      title: `Delivery ${job.reference_id} completed`,
      body: `Payout Rs.${payout}`,
    });

    await AuditLogModel.create({
      actorId: user.id,
      entity: 'job',
      entityId: job.id,
      action: 'delivery_completed',
      afterState: { payout },
    });

    return {
      jobId: job.id,
      referenceId: job.reference_id,
      deliveryFee: fee,
      payoutAmount: payout,
      commission,
    };
  },
};

module.exports = DeliveryService;
