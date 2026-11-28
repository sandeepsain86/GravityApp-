const { db, nowIso } = require('../../db/energy_provider/index');
const { insertInto, updateTable, parseJson } = require('./helpers');

const TABLE = 'jobs';

/** Stage machines per job type (documented in db/schema.js). */
const STAGE_FLOWS = {
  service: ['accepted', 'checked_in', 'diagnosed', 'parts_used', 'photos_done', 'completed'],
  repair: ['received', 'diagnosing', 'repairing', 'ready', 'dispatched'],
  panel: ['received', 'design_quote', 'fabricating', 'qc', 'dispatched'],
  delivery: ['pickup', 'to_workshop', 'delivered'],
};

const JobModel = {
  TABLE,
  STAGE_FLOWS,

  findById: async (id, handle = db) =>
    handle.get(`SELECT * FROM \`${TABLE}\` WHERE \`id\` = ?`, [id]),

  findByReference: async (referenceId, handle = db) =>
    handle.get(`SELECT * FROM \`${TABLE}\` WHERE \`reference_id\` = ?`, [referenceId]),

  findAll: async (handle = db) => handle.query(`SELECT * FROM \`${TABLE}\` ORDER BY \`id\``),

  /** Open jobs published to a marketplace; partner expertise is filtered per account in the service. */
  findOpenForRole: async (role, handle = db) =>
    handle.query(
      `SELECT * FROM \`${TABLE}\`
        WHERE \`target_role\` = ? AND \`status\` = 'open'
        ORDER BY \`id\` DESC`,
      [role]
    ),

  findOpenDelivery: async (handle = db) =>
    handle.query(
      `SELECT * FROM \`${TABLE}\` WHERE \`target_role\` = 'delivery_partner' AND \`status\` = 'open' ORDER BY \`id\``
    ),

  findAssignedTo: async (partnerId, handle = db) =>
    handle.query(
      `SELECT * FROM \`${TABLE}\` WHERE \`assigned_partner_id\` = ? ORDER BY \`id\` DESC`,
      [partnerId]
    ),

  findActiveForPartner: async (partnerId, handle = db) =>
    handle.query(
      `SELECT * FROM \`${TABLE}\`
        WHERE \`assigned_partner_id\` = ?
          AND \`status\` IN ('accepted', 'in_progress')
        ORDER BY CASE WHEN \`scheduled_at\` IS NULL THEN 1 ELSE 0 END, \`scheduled_at\`, \`created_at\`, \`id\``,
      [partnerId]
    ),

  findCompletedForPartner: async (partnerId, handle = db) =>
    handle.query(
      `SELECT * FROM \`${TABLE}\` WHERE \`assigned_partner_id\` = ? AND \`status\` = 'completed' ORDER BY \`id\` DESC`,
      [partnerId]
    ),

  create: async (jobData, handle = db) => {
    const id = await insertInto(
      TABLE,
      {
        reference_id: jobData.referenceId,
        job_type: jobData.jobType,
        target_role: jobData.targetRole,
        title: jobData.title,
        description: jobData.description || '',
        category: jobData.category || '',
        equipment: jobData.equipment || '',
        equipment_model: jobData.equipmentModel || '',
        brand: jobData.brand || '',
        issue_tags: jobData.issueTags || [],
        urgency: jobData.urgency || 'medium',
        customer_name: jobData.customerName || '',
        customer_company: jobData.customerCompany || '',
        customer_phone: jobData.customerPhone || '',
        site_address: jobData.siteAddress || '',
        site_area: jobData.siteArea || '',
        distance_km: jobData.distanceKm || 0,
        estimated_drive_minutes: jobData.estimatedDriveMinutes || 0,
        base_pay: jobData.basePay || 0,
        service_charge: jobData.serviceCharge || 0,
        status: jobData.status || 'open',
        stage: jobData.stage || null,
        scheduled_at: jobData.scheduledAt || null,
        sla_due_at: jobData.slaDueAt || null,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      handle
    );
    return JobModel.findById(id, handle);
  },

  updateById: async (id, updates, handle = db) => {
    await updateTable(TABLE, id, { ...updates, updated_at: nowIso() }, handle);
    return JobModel.findById(id, handle);
  },

  /**
   * Atomically claim an open job. The row-level busy lock ensures each partner
   * can accept only one active job; the conditional job update ensures exactly
   * one partner can claim a particular job.
   */
  claimOpenJob: async (id, partnerId, jobType = 'service', handle = db) => {
    const firstStage = (STAGE_FLOWS[jobType] || STAGE_FLOWS.service)[0];
    const assignedAt = nowIso();
    const result = await handle.run(
      `UPDATE \`${TABLE}\`
          SET \`status\` = 'accepted',
              \`assigned_partner_id\` = ?,
              \`stage\` = ?,
              \`assigned_at\` = ?,
              \`updated_at\` = ?
        WHERE \`id\` = ? AND \`status\` = 'open' AND \`assigned_partner_id\` IS NULL`,
      [partnerId, firstStage, assignedAt, assignedAt, id]
    );
    return result.affectedRows > 0;
  },

  deleteById: async (id, handle = db) => {
    const result = await handle.run(`DELETE FROM \`${TABLE}\` WHERE \`id\` = ?`, [id]);
    return result.affectedRows > 0;
  },

  toApi: (row, { includePii = true, includeCustomerPhone = false } = {}) => {
    if (!row) return null;
    const api = {
      id: row.id,
      referenceId: row.reference_id,
      jobType: row.job_type,
      targetRole: row.target_role,
      title: row.title,
      description: row.description,
      category: row.category,
      equipment: row.equipment,
      equipmentModel: row.equipment_model,
      brand: row.brand,
      issueTags: parseJson(row.issue_tags, []),
      urgency: row.urgency,
      customerCompany: row.customer_company,
      siteArea: row.site_area,
      siteAddress: row.site_address,
      distanceKm: row.distance_km,
      estimatedDriveMinutes: row.estimated_drive_minutes,
      basePay: row.base_pay,
      serviceCharge: row.service_charge,
      status: row.status,
      stage: row.stage,
      assignedPartnerId: row.assigned_partner_id,
      assignedAt: row.assigned_at || null,
      scheduledAt: row.scheduled_at || null,
      slaDueAt: row.sla_due_at,
      slaPaused: !!row.sla_paused,
      repairCenterRecommended: !!row.repair_center_recommended,
      checklist: parseJson(row.checklist, null),
      totalBill: row.total_bill,
      partsTotal: row.parts_total,
      payoutAmount: row.payout_amount,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };

    if (includePii) {
      api.customerName = row.customer_name;
      api.customerPhone = includeCustomerPhone ? row.customer_phone : null;
    } else {
      // Panel makers / workshop partners must not see customer contact details.
      api.customerName = 'Hidden';
      api.customerPhone = null;
    }

    return api;
  },
};

module.exports = JobModel;
