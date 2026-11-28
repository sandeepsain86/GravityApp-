const { pool: servicePool } = require('../../../../config/energy_service/db');
const { createAdminJobAssignmentService } = require('./admin-job-assignment');
const { createAdminRepairWorkflowService } = require('./admin-repair-workflow');
const { createAdminProjectWorkflow } = require('./admin-project-workflow');

const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const optionalNumeric = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value) => value === null || value === undefined ? '' : String(value);

const cleanFaultDescription = (value) => {
  const raw = (Array.isArray(value) ? JSON.stringify(value) : text(value)).trim();
  if (!raw) return '';
  let description = raw;
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        description = parsed.map((item) => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object') return '';
          return ['label', 'name', 'fault', 'issue', 'symptom', 'description']
            .map((key) => item[key])
            .filter((entry) => typeof entry === 'string' && entry.trim())
            .join(': ');
        }).filter(Boolean).join(' · ');
      }
    } catch {
      description = raw;
    }
  }
  const cleaned = description.replace(/\s+/g, ' ').trim();
  if (/^(?:(?:lorem ipsum|dummy|demo|sample|test)(?:[\s_-]+(?:data|record|job|ticket|description|fault|issue))*)[.! ]*$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
};

const jsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const listLabels = (value) => {
  if (Array.isArray(value)) return value.flatMap(listLabels);
  if (value && typeof value === 'object') {
    const label = text(value.name || value.title || value.label || value.code).trim();
    if (label) return [label];
    return [
      'specializations',
      'categories',
      'approvedCategories',
      'approvedProfileCategories',
      'skills',
      'items',
    ].flatMap((key) => listLabels(value[key]));
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return listLabels(JSON.parse(value));
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
};

const isoDate = (value) => value ? new Date(value).toISOString() : null;

const istDateKey = (value) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const daysBetweenDateKeys = (start, end) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);

const minutesBetween = (start, end) => {
  const startTime = start ? new Date(start).getTime() : NaN;
  const endTime = end ? new Date(end).getTime() : NaN;
  return Number.isFinite(startTime) && Number.isFinite(endTime)
    ? Math.max(0, Math.round((endTime - startTime) / 60_000))
    : null;
};

function mapPartner(row) {
  const specializations = [...new Set(listLabels(row.specialization_details))];
  return {
    id: String(row.id),
    name: text(row.business_name || row.full_name) || `Partner ${row.id}`,
    type: String(row.role).toLowerCase().includes('repair') ? 'repairing'
      : String(row.role).toLowerCase().includes('panel') ? 'panelmaker'
        : String(row.role).toLowerCase().includes('supplier') ? 'supplier' : 'service',
    rating: numeric(row.rating),
    jobsDone: numeric(row.jobs_completed),
    experienceYears: text(row.years_experience) || null,
    specializations,
    online: row.is_online === true || row.is_online === 1,
    lastLocationAt: row.last_location_at ? new Date(row.last_location_at).toISOString() : null,
    busy: row.is_busy === true || row.is_busy === 1,
    verified: row.status === 'active' || row.status === 'approved',
    city: cityName(row.address),
  };
}

const cityName = (value) => {
  if (!value || typeof value !== 'string') return '—';
  try {
    const address = JSON.parse(value);
    if (address && typeof address.city === 'string') return address.city;
    if (address && typeof address.locality === 'string') return address.locality;
  } catch {
    return '—';
  }
  return '—';
};

const source = (items, sourceStatus = 'connected') => ({ items, sourceStatus });
const providerQuery = async (sql) => (await servicePool.query(sql)).rows;

function jobStatus(row) {
  if (row.status === 'completed') return 'completed';
  const dueAt = row.sla_due_at ? new Date(row.sla_due_at).getTime() : NaN;
  if (Number.isFinite(dueAt) && dueAt < Date.now()) return 'sla-risk';
  return row.assigned_partner_id ? 'progress' : 'unassigned';
}

function jobStage(row) {
  if (row.status === 'completed') return undefined;
  if (row.stage === 'accepted' || row.status === 'accepted') return 'assigned';
  if (row.stage === 'dispatched') return 'scheduled';
  if (row.stage === 'received') return 'on-site';
  return row.assigned_partner_id ? 'assigned' : 'triage';
}

function mapJob(row, activityByJob, stageHistoryByJob = new Map()) {
  const slaDue = row.sla_due_at ? new Date(row.sla_due_at).getTime() : NaN;
  const amcEnd = row.company_amc_end_date ? new Date(row.company_amc_end_date).getTime() : NaN;
  const amcDaysLeft = Number.isFinite(amcEnd)
    ? Math.ceil((amcEnd - Date.now()) / 86_400_000)
    : null;
  const companyAmc = String(row.company_amc_status || '').toLowerCase() !== 'active'
    ? 'none'
    : amcDaysLeft !== null && amcDaysLeft <= 30 ? 'expiring' : 'active';
  const totalBill = numeric(row.total_bill);
  const basePay = numeric(row.base_pay);
  const serviceCharge = numeric(row.service_charge);
  const lastLocationAt = isoDate(row.live_location_updated_at);
  const locationAge = lastLocationAt ? Date.now() - Date.parse(lastLocationAt) : Infinity;
  const liveLocation = optionalNumeric(row.live_latitude) !== null &&
      optionalNumeric(row.live_longitude) !== null &&
      locationAge >= 0 && locationAge <= 90 * 60_000
    ? {
        latitude: optionalNumeric(row.live_latitude),
        longitude: optionalNumeric(row.live_longitude),
        updatedAt: lastLocationAt,
      }
    : null;
  return {
    id: text(row.reference_id || row.id),
    jobType: text(row.job_type),
    targetRole: text(row.target_role),
    company: text(row.customer_company || row.customer_name) || '—',
    service: text(row.title || row.job_type || row.category) || 'Service job',
    partner: row.partner_business_name || row.partner_name || null,
    partnerId: row.assigned_partner_id ? String(row.assigned_partner_id) : null,
    status: jobStatus(row),
    slaMinsLeft: Number.isFinite(slaDue)
      ? Math.ceil((slaDue - Date.now()) / 60_000)
      : null,
    amount: totalBill > 0 ? totalBill : basePay + serviceCharge,
    amountSource: totalBill > 0 ? 'customer quote' : basePay + serviceCharge > 0 ? 'base pay and service charge' : null,
    site: text(row.site_area || row.site_address) || '—',
    companyAmc,
    companySiteCount: optionalNumeric(row.company_site_count),
    category: text(row.category) || undefined,
    priority: ['critical', 'urgent', 'emergency'].includes(String(row.urgency).toLowerCase())
      ? 'critical'
      : ['high'].includes(String(row.urgency).toLowerCase()) ? 'high' : 'normal',
    requester: text(row.customer_name) || undefined,
    contactPhone: text(row.customer_phone) || undefined,
    siteAddress: text(row.site_address) || undefined,
    latitude: optionalNumeric(row.latitude),
    longitude: optionalNumeric(row.longitude),
    liveLocation,
    lastLocationAt,
    asset: [row.equipment, row.equipment_model, row.brand].filter(Boolean).map(text).join(' · ') || undefined,
    issue: cleanFaultDescription(row.description) || undefined,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : undefined,
    assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : undefined,
    slaDueAt: row.sla_due_at ? new Date(row.sla_due_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    totalBill: optionalNumeric(row.total_bill),
    payoutAmount: optionalNumeric(row.payout_amount),
    partsTotal: optionalNumeric(row.parts_total),
    beforePhotoCount: numeric(row.before_photo_count),
    afterPhotoCount: numeric(row.after_photo_count),
    rawStage: text(row.stage) || null,
    stage: jobStage(row),
    stageHistory: stageHistoryByJob.get(String(row.id)) || [],
    checklist: jsonArray(row.checklist).map((item, index) => ({
      id: text(item.id || item.key || `check-${index + 1}`),
      label: text(item.label || item.name || item.title),
      done: item.done === true || item.completed === true,
    })).filter((item) => item.label),
    activity: activityByJob.get(String(row.id)) || [],
  };
}

async function getJobs() {
  const [rows, activityRows, partnerRows] = await Promise.all([
    providerQuery(
      `SELECT job.id, job.reference_id, job.job_type, job.title, job.description, job.category,
              job.target_role, job.equipment, job.equipment_model, job.brand, job.urgency, job.customer_name,
              job.customer_company, job.customer_phone, job.site_address, job.site_area,
              job.latitude, job.longitude, job.total_bill, job.base_pay, job.service_charge,
              job.payout_amount, job.parts_total, job.completed_at,
              job.status, job.stage, job.assigned_partner_id, job.assigned_at,
              job.scheduled_at, job.sla_due_at, job.checklist, job.created_at, job.updated_at,
              live.latitude AS live_latitude, live.longitude AS live_longitude,
              live.updated_at AS live_location_updated_at,
              (SELECT COUNT(*)::int FROM energy_provider.job_photos photo
                WHERE photo.job_id = job.id AND LOWER(photo.photo_type) = 'before') AS before_photo_count,
              (SELECT COUNT(*)::int FROM energy_provider.job_photos photo
                WHERE photo.job_id = job.id AND LOWER(photo.photo_type) = 'after') AS after_photo_count,
              partner.full_name AS partner_name, partner.business_name AS partner_business_name,
              customer_sites.site_count AS company_site_count,
              customer_amc.status AS company_amc_status,
              customer_amc.end_date AS company_amc_end_date
         FROM energy_provider.jobs job
         LEFT JOIN energy_provider.users partner ON partner.id = job.assigned_partner_id
         LEFT JOIN energy_provider.job_live_locations live ON live.job_id = job.id
         LEFT JOIN LATERAL (
           SELECT company.id
             FROM public.companies company
            WHERE LOWER(TRIM(company.company_name)) =
                  LOWER(TRIM(COALESCE(job.customer_company, job.customer_name)))
            ORDER BY company.id
            LIMIT 1
         ) customer_company ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS site_count
             FROM public.sites site
            WHERE site.company_id = customer_company.id
         ) customer_sites ON TRUE
         LEFT JOIN LATERAL (
           SELECT contract.status, contract.end_date
             FROM public.amc_contracts contract
            WHERE contract.company_id = customer_company.id
            ORDER BY contract.end_date DESC NULLS LAST, contract.id DESC
            LIMIT 1
         ) customer_amc ON TRUE
        ORDER BY job.created_at DESC, job.id DESC`,
    ),
    providerQuery(
      `SELECT job_id, from_stage, to_stage, note, created_at
         FROM energy_provider.job_stage_history
        ORDER BY created_at, id`,
    ),
    getPartners(),
  ]);
  const activityByJob = new Map();
  const stageHistoryByJob = new Map();
  for (const row of activityRows) {
    const key = String(row.job_id);
    const entries = activityByJob.get(key) || [];
    const stages = stageHistoryByJob.get(key) || [];
    const note = text(row.note);
    stages.push({
      at: row.created_at ? new Date(row.created_at).toISOString() : '',
      fromStage: text(row.from_stage) || null,
      toStage: text(row.to_stage) || null,
      note: note || null,
    });
    entries.push({
      at: row.created_at ? new Date(row.created_at).toISOString() : '',
      title: note && row.from_stage === row.to_stage ? 'Work note' : 'Job stage updated',
      detail: note || `${text(row.from_stage) || 'Status'} → ${text(row.to_stage)}`,
    });
    activityByJob.set(key, entries);
    stageHistoryByJob.set(key, stages);
  }
  return {
    jobs: rows.map((row) => mapJob(row, activityByJob, stageHistoryByJob)),
    partners: partnerRows.items,
    sourceStatus: 'connected',
  };
}

async function getPartners(query = providerQuery) {
  const rows = await query(
    `SELECT partner.id, partner.full_name, partner.business_name, partner.role, partner.status,
            partner.rating, partner.jobs_completed,
            partner.years_experience, partner.specialization_details,
            partner.is_online, partner.is_busy, partner.address,
            latest_location.updated_at AS last_location_at
       FROM energy_provider.users partner
       LEFT JOIN LATERAL (
         SELECT live.updated_at
           FROM energy_provider.jobs active_job
           JOIN energy_provider.job_live_locations live ON live.job_id = active_job.id
          WHERE active_job.assigned_partner_id = partner.id
            AND active_job.status = 'in_progress'
            AND active_job.stage IN ('checked_in', 'diagnosed', 'parts_used', 'photos_done')
          ORDER BY live.updated_at DESC NULLS LAST, live.job_id DESC
          LIMIT 1
       ) latest_location ON TRUE
      WHERE partner.role IS NOT NULL AND partner.role <> 'admin'
      ORDER BY partner.full_name, partner.id`,
  );
  return source(rows.map(mapPartner));
}

async function getPartnerRoleCounts() {
  const rows = await providerQuery(
    `SELECT role, COUNT(*)::int AS count
       FROM energy_provider.users
      WHERE role IS NOT NULL AND role <> 'admin'
      GROUP BY role`,
  );
  const categories = {
    service: ['service', 'service_partner'],
    repairing: ['repairing', 'repairing_partner'],
    panelmaker: ['panelmaker', 'panel_maker'],
    supplier: ['supplier'],
  };
  const counts = new Map(rows.map((row) => [String(row.role).toLowerCase(), numeric(row.count)]));
  return source(Object.entries(categories).map(([type, roles]) => ({
    type,
    count: roles.reduce((total, role) => total + (counts.get(role) ?? 0), 0),
  })));
}

async function getVerifications() {
  const rows = await providerQuery(
    `SELECT application.id, application.partner_role, application.submitted_at,
            partner.full_name, partner.business_name,
            COALESCE(
              json_agg(DISTINCT document.doc_type)
                FILTER (WHERE document.doc_type IS NOT NULL),
              '[]'::json
            ) AS documents
       FROM energy_provider.partner_applications application
       JOIN energy_provider.users partner ON partner.id = application.user_id
       LEFT JOIN energy_provider.partner_documents document ON document.application_id = application.id
      WHERE application.status IN ('submitted', 'pending', 'under_review')
      GROUP BY application.id, partner.full_name, partner.business_name
      ORDER BY application.submitted_at DESC NULLS LAST, application.id DESC`,
  );
  return source(rows.map((row) => ({
    id: String(row.id),
    name: text(row.business_name || row.full_name) || `Application ${row.id}`,
    type: text(row.partner_role) || 'Partner',
    documents: jsonArray(row.documents).map(text).filter(Boolean),
    appliedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : '',
  })));
}

async function getCompanies() {
  const result = await servicePool.query(
    `SELECT company.id, company.company_name, company.gst_number, company.status,
            (SELECT COUNT(*)::int FROM sites site WHERE site.company_id = company.id) AS sites,
            (SELECT COUNT(*)::int FROM users member WHERE member.company_id = company.id) AS users,
            (SELECT COUNT(*)::int FROM energy_provider.jobs job
              WHERE LOWER(TRIM(job.customer_company)) = LOWER(TRIM(company.company_name))) AS total_jobs,
            COALESCE((
              SELECT SUM(order_row.total)
                FROM orders order_row
               WHERE order_row.company_id = company.id AND order_row.status <> 'cancelled'
            ), 0) +
            COALESCE((
              SELECT SUM(earning.gross_amount)
                FROM energy_provider.jobs job
                JOIN energy_provider.earnings earning ON earning.job_id = job.id
               WHERE LOWER(TRIM(job.customer_company)) = LOWER(TRIM(company.company_name))
            ), 0) AS revenue,
            (SELECT contract.status FROM amc_contracts contract
              WHERE contract.company_id = company.id
              ORDER BY contract.end_date DESC NULLS LAST LIMIT 1) AS amc_status,
            (SELECT contract.end_date FROM amc_contracts contract
              WHERE contract.company_id = company.id
              ORDER BY contract.end_date DESC NULLS LAST LIMIT 1) AS amc_end_date,
            GREATEST(
              (SELECT MAX(COALESCE(job.completed_at, job.created_at))
                 FROM energy_provider.jobs job
                WHERE LOWER(TRIM(COALESCE(job.customer_company, job.customer_name))) =
                      LOWER(TRIM(company.company_name))
                  AND job.status NOT IN ('cancelled', 'declined')),
              (SELECT MAX(COALESCE(request.completed_at, request.submitted_at, request.created_at))
                 FROM service_requests request
                WHERE request.company_id = company.id
                  AND request.status NOT IN ('draft', 'cancelled')),
              (SELECT MAX(COALESCE(ticket.completed_at, ticket.submitted_at, ticket.created_at))
                 FROM repair_tickets ticket
                WHERE ticket.company_id = company.id
                  AND ticket.status NOT IN ('draft', 'cancelled'))
            ) AS last_activity_at
       FROM companies company
      ORDER BY company.company_name, company.id`,
  );
  return source(result.rows.map((row) => {
    const daysLeft = row.amc_end_date
      ? Math.ceil((new Date(row.amc_end_date).getTime() - Date.now()) / 86_400_000)
      : null;
    const amc = row.amc_status !== 'active' ? 'None'
      : daysLeft !== null && daysLeft <= 30 ? 'Expiring' : 'Active';
    return {
      id: String(row.id),
      name: text(row.company_name),
      gst: text(row.gst_number),
      sites: numeric(row.sites),
      users: numeric(row.users),
      amc,
      totalJobs: numeric(row.total_jobs),
      revenue: numeric(row.revenue),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    };
  }));
}

async function getAmcs() {
  const result = await servicePool.query(
    `SELECT contract.id, contract.contract_number, contract.contract_type, contract.coverage,
            contract.end_date, contract.status, contract.company_id, company.company_name
       FROM amc_contracts contract
       LEFT JOIN companies company ON company.id = contract.company_id
      ORDER BY contract.end_date ASC NULLS LAST, contract.id`,
  );
  return source(result.rows.map((row) => {
    const endDate = row.end_date ? new Date(row.end_date) : null;
    return {
      id: text(row.contract_number || row.id),
      company: text(row.company_name) || '—',
      plan: [row.contract_type, row.coverage].filter(Boolean).map(text).join(' — ') || 'AMC',
      expires: endDate ? endDate.toISOString().slice(0, 10) : '',
      daysLeft: endDate ? Math.ceil((endDate.getTime() - Date.now()) / 86_400_000) : 0,
      compliance: text(row.status) || 'Unknown',
      value: null,
    };
  }));
}

async function getPayouts() {
  const rows = await providerQuery(
    `SELECT earning.id, earning.partner_id, earning.job_id, earning.net_amount,
            earning.status, earning.created_at, partner.full_name, partner.business_name
       FROM energy_provider.earnings earning
       LEFT JOIN energy_provider.users partner ON partner.id = earning.partner_id
      ORDER BY earning.created_at DESC, earning.id DESC`,
  );
  return source(rows.map((row) => ({
    id: String(row.id),
    partner: text(row.business_name || row.full_name) || `Partner ${row.partner_id}`,
    period: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '',
    jobs: row.job_id ? 1 : 0,
    amount: numeric(row.net_amount),
    status: row.status === 'paid' ? 'paid' : 'pending',
  })));
}

async function getInventory() {
  const rows = await providerQuery(
    `SELECT id, name, sku, category, quantity, reorder_level
       FROM energy_provider.inventory_items
      ORDER BY name, id`,
  );
  return source(rows.map((row) => ({
    sku: text(row.sku || row.id),
    name: text(row.name),
    category: text(row.category),
    stock: numeric(row.quantity),
    low: numeric(row.reorder_level),
    supplier: '—',
  })));
}

function repairStage(status) {
  switch (String(status).toLowerCase()) {
    case 'submitted':
    case 'received':
      return 'received';
    case 'diagnosis':
      return 'diagnosis';
    case 'estimate_required':
    case 'approved':
      return 'quote_approval';
    case 'repair_in_progress':
      return 'repairing';
    case 'ready':
      return 'qc_passed';
    case 'returned':
    case 'completed':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'draft';
  }
}

function isTestRepair(row) {
  const fields = [row.ticket_number, row.device_manufacturer, row.device_model, row.issue_description];
  const containsGeneratedNoise = fields.some((value) =>
    String(value || '').split(/\s+/).some((token) => {
      const normalized = token.replace(/[^a-z]/gi, '').toLowerCase();
      return normalized.length >= 6 && new Set(normalized).size <= 3;
    }),
  );
  return containsGeneratedNoise ||
    /\btest\s*(?:maker|ticket|device|account|panel)\b|\b(?:dummy|sandbox|demo|sample)\b/i
      .test(fields.join(' '));
}

async function getRepairs(query = (sql, values) => servicePool.query(sql, values)) {
  const result = await query(
    `SELECT ticket.id, ticket.ticket_number, ticket.repair_scope, ticket.service_type,
            ticket.priority, ticket.requested_turnaround, ticket.issue_description,
            ticket.symptoms, ticket.error_details, ticket.status, ticket.submitted_at,
            ticket.created_at, ticket.updated_at, ticket.completed_at,
            device.manufacturer AS device_manufacturer, device.model AS device_model,
            device.serial_number AS device_serial_number, device.asset_number AS device_asset_number,
            device.location AS device_location, company.company_name,
            site.site_name, amc.status AS amc_status, amc.end_date AS amc_end_date
       FROM public.repair_tickets ticket
       LEFT JOIN public.devices device ON device.id = ticket.device_id
       LEFT JOIN public.companies company ON company.id = ticket.company_id
       LEFT JOIN public.sites site ON site.id = ticket.site_id
       LEFT JOIN LATERAL (
         SELECT contract.status, contract.end_date
           FROM public.amc_contracts contract
          WHERE contract.company_id = ticket.company_id
            AND contract.site_id = ticket.site_id
          ORDER BY CASE
            WHEN LOWER(contract.status) = 'active'
              AND contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            THEN 0 ELSE 1
          END,
          contract.end_date DESC NULLS LAST, contract.id DESC
          LIMIT 1
       ) amc ON TRUE
      ORDER BY ticket.created_at DESC, ticket.id DESC`,
  );
  const ids = result.rows.map((row) => row.id);
  const historyByTicket = new Map();
  const metadataByTicket = new Map();
  if (ids.length) {
    const history = await query(
      `SELECT repair_ticket_id, new_status, remarks, created_at
         FROM public.repair_status_history
        WHERE repair_ticket_id = ANY($1::uuid[])
        ORDER BY created_at, id`,
      [ids],
    );
    for (const row of history.rows) {
      const key = String(row.repair_ticket_id);
      const events = historyByTicket.get(key) || [];
      events.push({
        status: text(row.remarks).startsWith('Workshop details updated by Superadmin ')
          ? 'workshop_details_updated'
          : text(row.new_status),
        remarks: text(row.remarks),
        at: row.created_at ? new Date(row.created_at).toISOString() : null,
      });
      historyByTicket.set(key, events);
      const remark = text(row.remarks);
      const metadataMatch = remark.match(/GH_REPAIR_METADATA:(\{.*?\})(?:\n|$)/);
      if (metadataMatch) {
        try {
          metadataByTicket.set(key, {
            ...(metadataByTicket.get(key) || {}),
            ...JSON.parse(metadataMatch[1]),
          });
        } catch {}
      }
    }
  }
  return source(result.rows.map((row) => {
    const metadata = metadataByTicket.get(String(row.id)) || {};
    return {
    id: text(row.id),
    ticketNumber: text(row.ticket_number || row.id),
    device: text([row.device_manufacturer, row.device_model].filter(Boolean).join(' ')) ||
      text(row.repair_scope || row.service_type) || 'Repair ticket',
    manufacturer: text(row.device_manufacturer),
    model: text(row.device_model),
    serialNumber: text(row.device_serial_number),
    assetNumber: text(row.device_asset_number),
    location: text(row.device_location),
    clientName: text(row.company_name),
    siteName: text(row.site_name),
    amcStatus: text(row.amc_status),
    amcEndDate: row.amc_end_date ? text(row.amc_end_date) : null,
    partner: null,
    stage: repairStage(row.status),
    status: text(row.status),
    fault: text(row.error_details || row.issue_description),
    symptoms: text(row.symptoms),
    serviceType: text(row.service_type),
    repairScope: text(row.repair_scope),
    priority: text(row.priority),
    requestedTurnaround: text(row.requested_turnaround),
    inAt: row.submitted_at || row.created_at
      ? new Date(row.submitted_at || row.created_at).toISOString()
      : '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    cost: optionalNumeric(metadata.estimatedCost),
    estimateRequired: row.status === 'estimate_required',
    quoteApproved: row.status === 'approved' || metadata.quoteApproved === true,
    spareParts: Array.isArray(metadata.spareParts) ? metadata.spareParts : [],
    benchPartnerId: text(metadata.benchPartnerId) || null,
    benchPartnerName: text(metadata.benchPartnerName) || null,
    partRequests: Array.isArray(metadata.partRequests) ? metadata.partRequests : [],
    diagnosisAt: null,
    testRecord: isTestRepair(row),
    history: historyByTicket.get(String(row.id)) || [],
    };
  }));
}

async function getProjects(query = servicePool.query.bind(servicePool)) {
  const result = await query(
    `SELECT request.id, request.request_number, request.title, request.estimated_scope,
            request.description, request.requirements, request.preferred_timeline,
            request.budget_amount, request.budget_currency, request.status,
            request.created_at, request.submitted_at, request.completed_at,
            company.company_name, site.site_name,
            category.name AS category_name, project_type.name AS project_type_name,
            COALESCE((
              SELECT jsonb_object_agg(detail.field_key, detail.field_value)
                FROM project_request_details detail
               WHERE detail.project_request_id = request.id
            ), '{}'::jsonb) AS details,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', milestone.id,
                'title', milestone.title,
                'sequence', milestone.sequence,
                'status', milestone.status,
                'plannedStart', milestone.planned_start,
                'dueDate', milestone.due_date,
                'completedAt', milestone.completed_at,
                'clientSignoffStatus', milestone.client_signoff_status,
                'leadEngineerName', milestone.lead_engineer_name,
                'budgetAmount', milestone.budget_amount,
                'materialCost', milestone.material_cost,
                'partnerPayout', milestone.partner_payout,
                'billedAmount', milestone.billed_amount
              ) ORDER BY milestone.sequence)
                FROM project_milestones milestone
               WHERE milestone.project_request_id = request.id
            ), '[]'::jsonb) AS milestones,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'oldStatus', history.old_status,
                'newStatus', history.new_status,
                'note', history.remarks,
                'changedAt', history.changed_at
              ) ORDER BY history.changed_at DESC)
                FROM project_status_history history
               WHERE history.project_request_id = request.id
            ), '[]'::jsonb) AS status_history
       FROM project_requests request
       LEFT JOIN companies company ON company.id = request.company_id
       LEFT JOIN sites site ON site.id = request.site_id
       LEFT JOIN project_categories category ON category.id = request.category_id
       LEFT JOIN project_types project_type ON project_type.id = request.project_type_id
      ORDER BY request.created_at DESC, request.id DESC`,
  );
  return source(result.rows.map((row) => ({
    id: text(row.request_number || row.id),
    requestId: text(row.id),
    company: text(row.company_name) || '—',
    title: text(row.title) || 'Project request',
    panels: text(row.estimated_scope) || '—',
    description: text(row.description),
    requirements: text(row.requirements),
    status: text(row.status).toLowerCase(),
    eta: text(row.preferred_timeline) || '—',
    value: optionalNumeric(row.budget_amount),
    currency: text(row.budget_currency) || 'INR',
    site: text(row.site_name) || '—',
    category: text(row.category_name) || '—',
    projectType: text(row.project_type_name) || '—',
    createdAt: isoDate(row.created_at),
    submittedAt: isoDate(row.submitted_at),
    completedAt: isoDate(row.completed_at),
    details: row.details && typeof row.details === 'object' ? row.details : {},
    milestones: Array.isArray(row.milestones) ? row.milestones : jsonArray(row.milestones),
    statusHistory: Array.isArray(row.status_history) ? row.status_history : jsonArray(row.status_history),
  })));
}

async function getAnalytics() {
  const [jobs, earnings, payments, repairs, contracts, requests, projects, payouts, lowStock] = await Promise.all([
    providerQuery(
      `SELECT job.id, job.reference_id, job.job_type, job.status, job.created_at,
              job.completed_at, job.assigned_at, job.sla_due_at, job.description,
              job.issue_tags, job.brand, job.assigned_partner_id,
              partner.business_name AS partner_name, partner.full_name AS partner_full_name,
              partner.rating AS partner_rating,
              COALESCE(customer_amc.active, FALSE) AS active_amc
         FROM energy_provider.jobs job
         LEFT JOIN energy_provider.users partner ON partner.id = job.assigned_partner_id
         LEFT JOIN LATERAL (
           SELECT BOOL_OR(
                    contract.status = 'active' AND
                    contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  ) AS active
             FROM public.companies company
             JOIN public.amc_contracts contract ON contract.company_id = company.id
            WHERE LOWER(TRIM(company.company_name)) =
                  LOWER(TRIM(COALESCE(job.customer_company, job.customer_name)))
         ) customer_amc ON TRUE
        WHERE job.created_at IS NOT NULL
        ORDER BY job.created_at DESC, job.id DESC`,
    ),
    providerQuery(
      `SELECT entry.id, entry.job_id, entry.partner_id, entry.source, entry.status,
              entry.gross_amount, entry.net_amount, entry.created_at, entry.payout_date,
              COALESCE(job.job_type, entry.source) AS job_type,
              partner.business_name AS partner_name, partner.full_name AS partner_full_name,
              partner.rating AS partner_rating,
              COALESCE(customer_amc.active, FALSE) AS active_amc
         FROM energy_provider.earnings entry
         LEFT JOIN energy_provider.jobs job ON job.id = entry.job_id
         LEFT JOIN energy_provider.users partner ON partner.id = entry.partner_id
         LEFT JOIN LATERAL (
           SELECT BOOL_OR(
                    contract.status = 'active' AND
                    contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  ) AS active
             FROM public.companies company
             JOIN public.amc_contracts contract ON contract.company_id = company.id
            WHERE LOWER(TRIM(company.company_name)) =
                  LOWER(TRIM(COALESCE(job.customer_company, job.customer_name)))
         ) customer_amc ON TRUE
        WHERE entry.created_at IS NOT NULL
        ORDER BY entry.created_at DESC, entry.id DESC`,
    ),
    servicePool.query(
      `SELECT order_row.id, order_row.status, order_row.created_at,
              payment.status AS payment_status, payment.amount,
              payment.created_at AS paid_at, payment.updated_at AS settled_at,
              EXISTS (
                SELECT 1 FROM amc_contracts contract
                 WHERE contract.company_id = order_row.company_id
                   AND contract.status = 'active'
                   AND contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              ) AS active_amc
         FROM orders order_row
         LEFT JOIN payments payment ON payment.order_id = order_row.id
        WHERE order_row.created_at IS NOT NULL
        ORDER BY order_row.created_at DESC, order_row.id DESC`,
    ),
    servicePool.query(
      `SELECT ticket.id, ticket.ticket_number, ticket.status, ticket.created_at,
              ticket.completed_at, ticket.issue_description, ticket.symptoms,
              device.manufacturer, device.model, ticket.company_id,
              EXISTS (
                SELECT 1 FROM amc_contracts contract
                 WHERE contract.company_id = ticket.company_id
                   AND contract.status = 'active'
                   AND contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              ) AS active_amc
         FROM repair_tickets ticket
         LEFT JOIN devices device ON device.id = ticket.device_id
        WHERE ticket.created_at IS NOT NULL
        ORDER BY ticket.created_at DESC, ticket.id DESC`,
    ),
    servicePool.query(
      `SELECT contract.id, contract.contract_number, contract.status,
              contract.created_at, contract.end_date, company.company_name
         FROM amc_contracts contract
         LEFT JOIN companies company ON company.id = contract.company_id
        WHERE contract.created_at IS NOT NULL
        ORDER BY contract.created_at DESC, contract.id DESC`,
    ),
    servicePool.query(
      `SELECT request.id, request.request_number, request.request_type,
              request.status, request.created_at, request.completed_at,
              request.submitted_at, company.company_name,
              EXISTS (
                SELECT 1 FROM amc_contracts contract
                 WHERE contract.company_id = request.company_id
                   AND contract.status = 'active'
                   AND contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              ) AS active_amc
         FROM amc_requests request
         LEFT JOIN companies company ON company.id = request.company_id
        WHERE request.created_at IS NOT NULL
        ORDER BY request.created_at DESC, request.id DESC`,
    ),
    servicePool.query(
      `SELECT request.id, request.request_number, request.title, request.status,
              request.created_at, request.completed_at, request.budget_amount,
              company.company_name,
              EXISTS (
                SELECT 1 FROM amc_contracts contract
                 WHERE contract.company_id = request.company_id
                   AND contract.status = 'active'
                   AND contract.end_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              ) AS active_amc
         FROM project_requests request
         LEFT JOIN companies company ON company.id = request.company_id
        WHERE request.created_at IS NOT NULL
        ORDER BY request.created_at DESC, request.id DESC`,
    ),
    providerQuery(
      `SELECT COALESCE(SUM(net_amount), 0) AS pending_amount
         FROM energy_provider.earnings
        WHERE status IN ('pending', 'failed')`,
    ),
    providerQuery(
      `SELECT inventory.id, inventory.name, inventory.sku, inventory.quantity,
              inventory.reorder_level, COUNT(DISTINCT part.job_id)::int AS recent_jobs_using
         FROM energy_provider.inventory_items inventory
         LEFT JOIN energy_provider.job_parts part
           ON LOWER(TRIM(part.part_name)) = LOWER(TRIM(inventory.name))
          AND part.created_at >= NOW() - INTERVAL '90 days'
        WHERE inventory.quantity <= inventory.reorder_level
        GROUP BY inventory.id, inventory.name, inventory.sku,
                 inventory.quantity, inventory.reorder_level
        ORDER BY inventory.quantity, inventory.name, inventory.id`,
    ),
  ]);
  const now = Date.now();
  const todayIst = istDateKey(new Date(now));
  const events = [];
  for (const row of jobs) {
    const jobType = String(row.job_type || '').toLowerCase();
    const category = ({
      service: 'SVC',
      repair: 'REP',
      panel: 'PANEL',
      delivery: 'DEL',
    })[jobType] || 'OTHER';
    const completed = String(row.status || '').toLowerCase() === 'completed';
    const dueAt = row.sla_due_at ? new Date(row.sla_due_at).getTime() : NaN;
    const completedAt = row.completed_at ? new Date(row.completed_at).getTime() : NaN;
    const slaBreached = Number.isFinite(dueAt)
      ? completed
        ? Number.isFinite(completedAt) ? completedAt > dueAt : null
        : !['cancelled', 'declined'].includes(String(row.status || '').toLowerCase()) && dueAt < now
      : null;
    const issue = cleanFaultDescription(row.issue_tags) || cleanFaultDescription(row.description);
    events.push({
      id: `job:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: null,
      amount: 0,
      grossRevenue: 0,
      refundAmount: 0,
      refundAt: null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category,
      kind: 'job',
      jobType,
      status: String(row.status || '').toLowerCase(),
      completedAt: isoDate(row.completed_at),
      assignedAt: isoDate(row.assigned_at),
      slaDueAt: isoDate(row.sla_due_at),
      slaBreachAt: slaBreached ? isoDate(completed ? row.completed_at : row.sla_due_at) : null,
      slaBreached,
      delayMinutes: slaBreached ? minutesBetween(row.sla_due_at, completed
        ? row.completed_at
        : new Date(now)) : null,
      mttrMinutes: completed ? minutesBetween(row.created_at, row.completed_at) : null,
      dispatchMinutes: minutesBetween(row.created_at, row.assigned_at),
      partnerId: row.assigned_partner_id ? String(row.assigned_partner_id) : null,
      partnerName: text(row.partner_name || row.partner_full_name) || null,
      partnerRating: optionalNumeric(row.partner_rating),
      activeAmc: row.active_amc === true,
      issue: issue || null,
      oem: text(row.brand) || null,
      revenueSource: null,
    });
  }
  for (const row of earnings) {
    const jobType = String(row.job_type || '').toLowerCase();
    const category = ({
      service: 'SVC',
      repair: 'REP',
      panel: 'PANEL',
      delivery: 'DEL',
    })[jobType] || 'OTHER';
    const paid = String(row.status || '').toLowerCase() === 'paid';
    const pending = ['pending', 'failed'].includes(String(row.status || '').toLowerCase());
    const grossRevenue = numeric(row.gross_amount);
    const payoutAmount = numeric(row.net_amount);
    events.push({
      id: `earning:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: isoDate(row.created_at),
      amount: grossRevenue,
      grossRevenue,
      refundAmount: 0,
      refundAt: null,
      payoutAmount,
      pendingPayout: pending ? payoutAmount : 0,
      paidPayout: paid ? payoutAmount : 0,
      payoutAt: paid ? isoDate(row.payout_date) : null,
      category,
      kind: 'earning',
      jobType,
      status: String(row.status || '').toLowerCase(),
      completedAt: null,
      assignedAt: null,
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: null,
      dispatchMinutes: null,
      partnerId: row.partner_id ? String(row.partner_id) : null,
      partnerName: text(row.partner_name || row.partner_full_name) || null,
      partnerRating: optionalNumeric(row.partner_rating),
      activeAmc: row.active_amc === true,
      issue: null,
      oem: null,
      revenueSource: 'partner earnings',
    });
  }
  for (const row of payments.rows) {
    const refunded = row.payment_status === 'refunded';
    const paid = row.payment_status === 'succeeded' || refunded;
    const amount = paid ? numeric(row.amount) : 0;
    events.push({
      id: `order:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: paid
        ? isoDate(refunded ? row.paid_at : row.settled_at)
        : null,
      amount,
      grossRevenue: amount,
      refundAmount: refunded ? amount : 0,
      refundAt: refunded ? isoDate(row.settled_at) : null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category: 'ORDERS',
      kind: 'order',
      status: String(row.status || '').toLowerCase(),
      completedAt: null,
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: null,
      dispatchMinutes: null,
      partnerId: null,
      partnerName: null,
      partnerRating: null,
      activeAmc: row.active_amc === true,
      issue: null,
      oem: null,
      revenueSource: paid ? 'order payment' : null,
    });
  }
  for (const row of repairs.rows) {
    events.push({
      id: `repair:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: null,
      amount: 0,
      grossRevenue: 0,
      refundAmount: 0,
      refundAt: null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category: 'REP',
      kind: 'repair-ticket',
      status: String(row.status || '').toLowerCase(),
      completedAt: isoDate(row.completed_at),
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: row.completed_at ? minutesBetween(row.created_at, row.completed_at) : null,
      dispatchMinutes: null,
      partnerId: null,
      partnerName: null,
      partnerRating: null,
      activeAmc: row.active_amc === true,
      issue: cleanFaultDescription(row.issue_description || row.symptoms) || null,
      oem: [row.manufacturer, row.model].filter(Boolean).map(text).join(' ') || null,
      revenueSource: null,
    });
  }
  for (const row of contracts.rows) {
    events.push({
      id: `amc:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: null,
      amount: 0,
      grossRevenue: 0,
      refundAmount: 0,
      refundAt: null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category: 'AMC',
      kind: 'amc-contract',
      status: String(row.status || '').toLowerCase(),
      completedAt: null,
      expiresAt: row.end_date ? isoDate(row.end_date) : null,
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: null,
      dispatchMinutes: null,
      partnerId: null,
      partnerName: null,
      partnerRating: null,
      activeAmc: String(row.status || '').toLowerCase() === 'active' &&
        row.end_date && istDateKey(row.end_date) >= todayIst,
      issue: null,
      oem: null,
      company: text(row.company_name) || null,
      revenueSource: null,
    });
  }
  for (const row of requests.rows) {
    events.push({
      id: `amc-request:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: null,
      amount: 0,
      grossRevenue: 0,
      refundAmount: 0,
      refundAt: null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category: 'AMC',
      kind: 'amc-request',
      status: String(row.status || '').toLowerCase(),
      requestType: text(row.request_type),
      completedAt: isoDate(row.completed_at),
      submittedAt: isoDate(row.submitted_at),
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: null,
      dispatchMinutes: null,
      partnerId: null,
      partnerName: null,
      partnerRating: null,
      activeAmc: row.active_amc === true,
      issue: null,
      oem: null,
      company: text(row.company_name) || null,
      revenueSource: null,
    });
  }
  for (const row of projects.rows) {
    events.push({
      id: `project:${row.id}`,
      at: isoDate(row.created_at),
      activityAt: isoDate(row.created_at),
      revenueAt: null,
      amount: 0,
      grossRevenue: 0,
      refundAmount: 0,
      refundAt: null,
      payoutAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
      payoutAt: null,
      category: 'PANEL',
      kind: 'project',
      status: String(row.status || '').toLowerCase(),
      completedAt: isoDate(row.completed_at),
      estimatedBudget: optionalNumeric(row.budget_amount),
      slaDueAt: null,
      slaBreachAt: null,
      slaBreached: null,
      delayMinutes: null,
      mttrMinutes: row.completed_at ? minutesBetween(row.created_at, row.completed_at) : null,
      dispatchMinutes: null,
      partnerId: null,
      partnerName: null,
      partnerRating: null,
      activeAmc: row.active_amc === true,
      issue: text(row.title) || null,
      oem: null,
      company: text(row.company_name) || null,
      revenueSource: null,
    });
  }
  const activeContracts = contracts.rows.filter((row) =>
    String(row.status || '').toLowerCase() === 'active' &&
    row.end_date && istDateKey(row.end_date) >= todayIst,
  );
  const expiringContracts = activeContracts.filter((row) => {
    if (!row.end_date) return false;
    const daysLeft = daysBetweenDateKeys(todayIst, istDateKey(row.end_date));
    return daysLeft >= 0 && daysLeft <= 30;
  });
  const openAmcRequests = requests.rows.filter((row) =>
    !!row.submitted_at &&
    ['submitted', 'under_review', 'scheduled', 'reschedule_requested', 'rescheduled', 'confirmed']
      .includes(String(row.status || '').toLowerCase()),
  );
  return {
    ...source(events.sort((a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime())),
    insights: {
      pendingPayouts: numeric(payouts[0]?.pending_amount),
      activeAmcContracts: activeContracts.length,
      expiringAmcContracts: expiringContracts.length,
      openAmcRequests: openAmcRequests.length,
      recurringAmcValue: null,
      recurringAmcValueAvailable: false,
      invoiceDataAvailable: false,
      taxDataAvailable: false,
      lowStockItems: lowStock.map((row) => ({
        id: String(row.id),
        name: text(row.name),
        sku: text(row.sku),
        quantity: numeric(row.quantity),
        reorderLevel: numeric(row.reorder_level),
        recentJobsUsing: numeric(row.recent_jobs_using),
      })),
    },
  };
}

const readers = {
  jobs: getJobs,
  livemonitor: getJobs,
  'partner-app': getPartnerRoleCounts,
  verification: getVerifications,
  disputes: async () => ({
    ...source([], 'not-connected'),
    message: 'No connected disputes data source is configured.',
  }),
  companies: getCompanies,
  amc: getAmcs,
  finance: getPayouts,
  invoices: async () => ({ ...source([], 'not-connected'), message: 'No invoice table or API is connected.' }),
  inventory: getInventory,
  repair: getRepairs,
  projects: getProjects,
  analytics: getAnalytics,
};

function createOperationsDirectory() {
  const assignmentService = createAdminJobAssignmentService();
  const repairWorkflowService = createAdminRepairWorkflowService(servicePool);
  const projectWorkflowService = createAdminProjectWorkflow(servicePool);
  return {
    async getData(domain) {
      const reader = readers[domain];
      return reader ? reader() : null;
    },
    assignJob: assignmentService.assignJob,
    transitionRepairStage: repairWorkflowService.transitionStage,
    updateRepairWorkshop: repairWorkflowService.updateWorkshopDetails,
    assignRepairPartnerToMany: repairWorkflowService.assignPartnerToRepairs,
    transitionProjectStatus: projectWorkflowService.transitionStatus,
    createProjectMilestone: projectWorkflowService.createMilestone,
    updateProjectMilestone: projectWorkflowService.updateMilestone,
  };
}

module.exports = {
  createOperationsDirectory,
  cleanFaultDescription,
  mapJob,
  getPartners,
  getProjects,
  getRepairs,
  repairStage,
  isTestRepair,
};
