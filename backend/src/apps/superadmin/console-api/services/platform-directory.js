const { db: providerDb } = require('../../../../db/energy_provider');
const { pool: servicePool } = require('../../../../config/energy_service/db');

const text = (value) => (value === null || value === undefined || value === '' ? null : String(value));
const numeric = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};
const boolean = (value) => value === true || value === 1 || value === '1' || value === 'true';
const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const asIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};
const asDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
const parseArray = (value) => {
  const toString = (entry) => {
    if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.name || entry.title || entry.label || entry.code || '');
  };
  if (Array.isArray(value)) return value.flatMap((entry) => {
    const label = toString(entry);
    return label ? [label] : parseArray(entry);
  });
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parseArray(parsed);
    if (parsed && typeof parsed === 'object') {
      const label = toString(parsed);
      if (label) return [label];
      return ['specializations', 'categories', 'approvedCategories', 'approvedProfileCategories', 'skills', 'items']
        .flatMap((key) => parseArray(parsed[key]));
    }
    if (typeof parsed === 'string') return parsed.split(',').map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
};
const asObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

function providerSpecializations(application, user) {
  const details = asObject(application?.specializations || user.specialization_details);
  const professional = asObject(application?.professional_details);
  const values = [
    ...parseArray(application?.categories),
    ...parseArray(application?.specializations),
    ...parseArray(user.specialization_details),
    ...parseArray(professional.specializations),
    ...parseArray(professional.skills),
  ];
  if (typeof details.name === 'string') values.push(details.name);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildProviderRegistrations(users, applications, jobs, jobCounts, earnings) {
  const latestApplication = new Map();
  for (const application of applications) {
    const key = `${application.user_id}:${application.partner_role}`;
    if (!latestApplication.has(key)) latestApplication.set(key, application);
  }

  const activeJobByPartner = new Map();
  for (const job of jobs) {
    if (!activeJobByPartner.has(String(job.assigned_partner_id))) {
      activeJobByPartner.set(String(job.assigned_partner_id), job);
    }
  }

  const earningsByPartner = new Map();
  for (const earning of earnings) {
    const totals = earningsByPartner.get(String(earning.partner_id)) || { total: 0, pending: 0 };
    totals.total += numeric(earning.net_amount);
    if (earning.status === 'pending') totals.pending += numeric(earning.net_amount);
    earningsByPartner.set(String(earning.partner_id), totals);
  }

  const serviceCountByPartner = new Map();
  for (const row of jobCounts) {
    serviceCountByPartner.set(String(row.assigned_partner_id), numeric(row.total_services));
  }

  return users.map((user) => {
    const application = latestApplication.get(`${user.id}:${user.role}`);
    const job = activeJobByPartner.get(String(user.id));
    const earned = earningsByPartner.get(String(user.id)) || { total: 0, pending: 0 };
    const name = text(user.full_name) || text(user.business_name) || `Partner ${user.id}`;
    const storedRating = optionalNumber(user.rating);
    const externalRegistrationId = text(application?.reference_id) || text(user.reference_id);

    return {
      id: `energy-hub:${user.id}`,
      registrationId: externalRegistrationId
        ? `${externalRegistrationId}-U${user.id}`
        : `EH-PARTNER-${user.id}`,
      app: 'energy-hub',
      name,
      email: text(user.email),
      phone: text(user.mobile),
      role: text(user.role) || 'partner',
      status: text(user.status) || 'pending',
      registeredAt: asIso(application?.submitted_at || application?.created_at || user.created_at),
      profile: {
        businessName: text(user.business_name),
        companyName: null,
        registeredAddress: text(user.address),
        serviceAreas: parseArray(application?.service_areas || user.service_areas),
        specializations: providerSpecializations(application, user),
        experienceYears: text(user.years_experience),
        qualification: text(user.qualification_details) || text(user.qualification),
        online: boolean(user.is_online),
        busy: boolean(user.is_busy),
        completedServices: numeric(user.jobs_completed),
        totalServices: Math.max(
          numeric(user.jobs_completed),
          serviceCountByPartner.get(String(user.id)) || 0,
        ),
        totalEarnings: earned.total,
        pendingEarnings: earned.pending,
        rating: storedRating !== null && storedRating > 0 ? storedRating : null,
        ratingCount: null,
        ratings: [],
        latestService: job
          ? {
              id: text(job.reference_id) || String(job.id),
              title: text(job.title) || 'Active service',
              status: String(job.status),
              stage: text(job.stage),
              location: text(job.site_address) || text(job.site_area),
              scheduledAt: asIso(job.scheduled_at),
              scheduledTime: null,
              slaDueAt: asIso(job.sla_due_at),
              travelEtaMinutes: optionalNumber(job.estimated_drive_minutes),
              at: asIso(job.updated_at || job.created_at),
            }
          : null,
      },
    };
  });
}

function buildServiceRegistrations(users) {
  return users.map((user) => {
    const latestService = user.latest_service_id
      ? {
          id: String(user.latest_service_id),
          title: text(user.latest_service_title) || 'Service request',
          status: String(user.latest_service_status),
          stage: null,
          location: text(user.latest_service_location),
          scheduledAt: asDateOnly(user.latest_service_date),
          scheduledTime: text(user.latest_service_time),
          slaDueAt: null,
          travelEtaMinutes: null,
          at: asIso(user.latest_service_at),
        }
      : null;

    return {
      id: `service-admin:${user.id}`,
      registrationId: `SA-CUSTOMER-${user.id}`,
      app: 'service-admin',
      name: text(user.full_name) || 'Unnamed account',
      email: text(user.email),
      phone: text(user.phone),
      role: text(user.role) || 'user',
      status: text(user.status) || 'active',
      registeredAt: asIso(user.created_at),
      profile: {
        businessName: null,
        companyName: text(user.company_name),
        registeredAddress: text(user.company_city),
        serviceAreas: [],
        specializations: [],
        experienceYears: null,
        qualification: null,
        online: null,
        busy: false,
        completedServices: numeric(user.completed_services),
        totalServices: numeric(user.total_services),
        totalEarnings: null,
        pendingEarnings: null,
        rating: null,
        ratingCount: null,
        ratings: [],
        latestService,
      },
    };
  });
}

function statusCounts(activity) {
  const counts = new Map();
  for (const item of activity) counts.set(item.status, (counts.get(item.status) || 0) + 1);
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

function activityByMonth(activity, amounts) {
  const months = new Map();
  const bucketFor = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!months.has(key)) months.set(key, { month: key, count: 0, amount: 0 });
    return months.get(key);
  };
  for (const item of activity) {
    const bucket = bucketFor(item.createdAt);
    if (bucket) bucket.count += 1;
  }
  for (const item of amounts) {
    const bucket = bucketFor(item.at);
    if (bucket) bucket.amount += numeric(item.amount);
  }
  return [...months.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .slice(-6)
    .map((item) => {
      const [year, month] = item.month.split('-').map(Number);
      return {
        ...item,
        label: new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })
          .format(new Date(Date.UTC(year, month - 1, 1))),
      };
    });
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = String(row[key]);
    const entries = grouped.get(value) || [];
    entries.push(row);
    grouped.set(value, entries);
  }
  return grouped;
}

function timelineFor(rows, { label = 'Status update', statusKey = 'status', noteKey = 'note' } = {}) {
  return rows.map((row) => ({
    label,
    status: text(row[statusKey]) || 'updated',
    note: text(row[noteKey]),
    at: asIso(row.at),
  }));
}

function summarizeEarnings(earnings) {
  return earnings.reduce((summary, earning) => {
    summary.total += earning.net;
    summary.commission += earning.commission;
    summary.deductions += earning.deductions;
    if (earning.status === 'paid') summary.paid += earning.net;
    else if (earning.status === 'failed') summary.failed += earning.net;
    else summary.pending += earning.net;
    return summary;
  }, { kind: 'payouts', total: 0, paid: 0, pending: 0, failed: 0, commission: 0, deductions: 0, count: earnings.length });
}

function summarizeOrders(orders) {
  return orders.reduce((summary, order) => {
    summary.total += order.total;
    if (['paid', 'succeeded', 'success', 'completed'].includes((order.paymentStatus || '').toLowerCase())) {
      summary.paid += order.total;
    } else if (['failed', 'declined', 'cancelled'].includes((order.paymentStatus || order.status).toLowerCase())) {
      summary.failed += order.total;
    } else {
      summary.pending += order.total;
    }
    return summary;
  }, { kind: 'orders', total: 0, paid: 0, pending: 0, failed: 0, commission: 0, deductions: 0, count: orders.length });
}

function shortText(value, limit = 240) {
  const result = text(value);
  if (!result) return null;
  return result.length > limit ? `${result.slice(0, limit).trimEnd()}…` : result;
}

async function getProviderDetails(connections, userId) {
  const { providerDb } = connections;
  const [users, applications, jobs, earningsRows, documents, vehicles, stageRows, workflowRows, liveLocations] = await Promise.all([
    providerDb.query(
      `SELECT id, mobile, email, role, status, full_name, business_name, address, profile_photo,
              years_experience, qualification, qualification_details, specialization_details,
              service_areas, rating, jobs_completed, is_online, is_busy, reference_id,
              partner_since, travel_radius_km, created_at, updated_at, bank_account_holder, bank_name
         FROM users
        WHERE id = ? AND role IS NOT NULL AND role <> 'admin'`,
      [userId],
    ),
    providerDb.query(
      `SELECT id, user_id, partner_role, status, current_step, reference_id, service_areas,
              rejection_reason, submitted_at, updated_at
         FROM partner_applications
        WHERE user_id = ?
        ORDER BY id DESC`,
      [userId],
    ),
    providerDb.query(
      `SELECT id, reference_id, job_type, title, description, category, equipment, equipment_model,
              brand, urgency, status, stage, site_address, site_area, scheduled_at, sla_due_at,
              estimated_drive_minutes, distance_km, total_bill, payout_amount, completed_at,
              created_at, updated_at
         FROM jobs
        WHERE assigned_partner_id = ?
        ORDER BY created_at DESC, id DESC`,
      [userId],
    ),
    providerDb.query(
      `SELECT id, job_id, source, gross_amount, commission, deductions, net_amount, status,
              payout_date, created_at
         FROM earnings
        WHERE partner_id = ?
        ORDER BY created_at DESC, id DESC`,
      [userId],
    ),
    providerDb.query(
      `SELECT doc_type, status, rejection_reason, created_at
         FROM partner_documents
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC`,
      [userId],
    ),
    providerDb.query(
      `SELECT vehicle_type, status, rejection_reason
         FROM delivery_verifications
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`,
      [userId],
    ),
    providerDb.query(
      `SELECT history.job_id, history.from_stage, history.to_stage, history.created_at AS at
         FROM job_stage_history history
         JOIN jobs job ON job.id = history.job_id
        WHERE job.assigned_partner_id = ?
        ORDER BY history.created_at`,
      [userId],
    ),
    providerDb.query(
      `SELECT step.job_id, step.step_key, step.status, step.checked_in_at, step.completed_at,
              COALESCE(step.completed_at, step.checked_in_at, step.updated_at, step.created_at) AS at
         FROM job_workflow_steps step
         JOIN jobs job ON job.id = step.job_id
        WHERE job.assigned_partner_id = ?
        ORDER BY step.job_id, step.step_number`,
      [userId],
    ),
    providerDb.query(
      `SELECT live.job_id, live.latitude, live.longitude, live.updated_at
         FROM job_live_locations live
         JOIN jobs job ON job.id = live.job_id
        WHERE job.assigned_partner_id = ?
          AND job.status = 'in_progress'
          AND job.stage IN ('checked_in', 'diagnosed', 'parts_used', 'photos_done')
        ORDER BY live.updated_at DESC
        LIMIT 1`,
      [userId],
    ),
  ]);
  const user = users[0];
  if (!user) return null;

  const activeJobs = jobs.filter((job) => job.status === 'accepted' || job.status === 'in_progress');
  const latestLocation = liveLocations[0];
  const currentJob = activeJobs.find((job) =>
    String(job.id) === String(latestLocation?.job_id),
  ) || activeJobs[0] || null;
  const locationBelongsToCurrentJob = currentJob &&
    String(latestLocation?.job_id) === String(currentJob.id);
  const lastLocationUpdateAt = locationBelongsToCurrentJob
    ? asIso(latestLocation.updated_at)
    : null;
  const locationAge = lastLocationUpdateAt ? Date.now() - Date.parse(lastLocationUpdateAt) : Infinity;
  const latitude = optionalNumber(latestLocation?.latitude);
  const longitude = optionalNumber(latestLocation?.longitude);
  const liveLocation = locationBelongsToCurrentJob && locationAge >= 0 && locationAge <= 120000 &&
    latitude !== null && latitude >= -90 && latitude <= 90 &&
    longitude !== null && longitude >= -180 && longitude <= 180
    ? {
      latitude,
      longitude,
    }
    : null;
  const registration = buildProviderRegistrations(
    [user],
    applications,
    activeJobs,
    [{ assigned_partner_id: user.id, total_services: jobs.length }],
    earningsRows,
  )[0];
  const stagesByJob = groupBy(stageRows, 'job_id');
  const workflowByJob = groupBy(workflowRows, 'job_id');
  const currentJobWorkflow = currentJob
    ? workflowByJob.get(String(currentJob.id)) || []
    : [];
  const checkInStep = currentJobWorkflow.find((step) => step.step_key === 'checkin');
  const activity = jobs.map((job) => {
    const timeline = [
      ...timelineFor(stagesByJob.get(String(job.id)) || [], { label: 'Stage changed', statusKey: 'to_stage' }),
      ...(workflowByJob.get(String(job.id)) || []).map((step) => ({
        label: text(step.step_key) || 'Work step',
        status: text(step.status) || 'updated',
        note: null,
        at: asIso(step.at),
      })),
    ].sort((left, right) => (Date.parse(left.at || '') || 0) - (Date.parse(right.at || '') || 0));
    const details = [
      text(job.category),
      [text(job.equipment), text(job.equipment_model)].filter(Boolean).join(' · '),
      text(job.brand),
    ].filter(Boolean);
    return {
      id: String(job.id),
      kind: 'job',
      reference: text(job.reference_id) || String(job.id),
      title: text(job.title) || 'Service job',
      status: text(job.status) || 'unknown',
      priority: text(job.urgency),
      description: shortText(job.description),
      location: text(job.site_address) || text(job.site_area),
      createdAt: asIso(job.created_at),
      scheduledAt: asIso(job.scheduled_at),
      completedAt: asIso(job.completed_at),
      dueAt: asIso(job.sla_due_at),
      assignedTo: null,
      amount: optionalNumber(job.total_bill),
      currency: 'INR',
      details,
      timeline,
      payoutAmount: optionalNumber(job.payout_amount),
      travelEtaMinutes: optionalNumber(job.estimated_drive_minutes),
      distanceKm: optionalNumber(job.distance_km),
    };
  });
  const earnings = earningsRows.map((earning) => ({
    id: String(earning.id),
    jobReference: text(jobs.find((job) => String(job.id) === String(earning.job_id))?.reference_id),
    source: text(earning.source),
    gross: numeric(earning.gross_amount),
    commission: numeric(earning.commission),
    deductions: numeric(earning.deductions),
    net: numeric(earning.net_amount),
    status: text(earning.status) || 'pending',
    createdAt: asIso(earning.created_at),
    payoutAt: asIso(earning.payout_date),
  }));
  const latestApplication = applications[0];
  const vehicle = vehicles[0];

  return {
    registration,
    account: {
      avatarUrl: text(user.profile_photo),
      secondaryPhone: null,
      emailVerified: null,
      phoneVerified: null,
      lastLoginAt: null,
      updatedAt: asIso(user.updated_at),
      currentWork: currentJob ? {
        id: String(currentJob.id),
        reference: text(currentJob.reference_id),
        title: text(currentJob.title) || 'Service job',
        stage: text(currentJob.stage) || text(currentJob.status) || 'unknown',
        site: text(currentJob.site_address) || text(currentJob.site_area),
        startedAt: asIso(currentJob.created_at),
        checkedInAt: asIso(checkInStep?.checked_in_at || checkInStep?.completed_at),
        lastLocationUpdateAt,
        liveLocation,
        distanceKm: optionalNumber(currentJob.distance_km),
        travelEtaMinutes: optionalNumber(currentJob.estimated_drive_minutes),
      } : null,
      partnerSince: asIso(user.partner_since),
      travelRadiusKm: optionalNumber(user.travel_radius_km),
      onboarding: latestApplication ? {
        status: text(latestApplication.status),
        currentStep: optionalNumber(latestApplication.current_step),
        submittedAt: asIso(latestApplication.submitted_at),
        rejectionReason: text(latestApplication.rejection_reason),
      } : null,
      payoutProfileConfigured: Boolean(user.bank_account_holder && user.bank_name),
      vehicleVerification: vehicle ? {
        type: text(vehicle.vehicle_type) || 'Vehicle',
        status: text(vehicle.status) || 'unknown',
        rejectionReason: text(vehicle.rejection_reason),
      } : null,
      companies: [],
      sites: [],
      devices: [],
      documents: documents.map((document) => ({
        type: text(document.doc_type) || 'Document',
        status: text(document.status) || 'pending',
        uploadedAt: asIso(document.created_at),
        rejectionReason: text(document.rejection_reason),
      })),
    },
    activity,
    statusBreakdown: statusCounts(activity),
    monthlyActivity: activityByMonth(
      activity.map((item) => ({ createdAt: item.completedAt || item.createdAt })),
      earnings.map((item) => ({ at: item.payoutAt || item.createdAt, amount: item.net })),
    ),
    financialSummary: summarizeEarnings(earnings),
    earnings,
    orders: [],
    supportRequests: [],
  };
}

function serviceTimelineRows(rows, idKey) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row[idKey]);
    const entries = grouped.get(key) || [];
    entries.push({
      label: 'Status changed',
      status: text(row.status) || 'updated',
      note: shortText(row.note),
      at: asIso(row.at),
    });
    grouped.set(key, entries);
  }
  return grouped;
}

async function getServiceAdminDetails(connections, userId) {
  const { servicePool } = connections;
  const registrationResult = await servicePool.query(
    `WITH service_totals AS (
       SELECT customer.user_id,
              COUNT(request.id)::int AS total_services,
              COUNT(request.id) FILTER (WHERE request.status = 'completed')::int AS completed_services
         FROM public.customers customer
         LEFT JOIN public.service_requests request ON request.customer_id = customer.id
        WHERE customer.user_id = $1
        GROUP BY customer.user_id
     ), latest_services AS (
       SELECT DISTINCT ON (customer.user_id)
              customer.user_id, request.request_number, request.status,
              category.name AS service_name,
              CONCAT_WS(', ', site.site_name, site.address) AS site_location,
              request.preferred_date, request.preferred_time, request.created_at
         FROM public.customers customer
         JOIN public.service_requests request ON request.customer_id = customer.id
         LEFT JOIN public.service_categories category ON category.id = request.category_id
         LEFT JOIN public.sites site ON site.id = request.site_id
        WHERE customer.user_id = $1
        ORDER BY customer.user_id, request.created_at DESC
     )
     SELECT u.id, u.name AS full_name, u.email, u.phone, u.secondary_phone,
            u.email_verified, u.phone_verified, u.status, u.avatar_url,
            u.last_login_at, u.created_at, u.updated_at, role.name AS role,
            co.company_name, co.city AS company_city,
            COALESCE(totals.total_services, 0) AS total_services,
            COALESCE(totals.completed_services, 0) AS completed_services,
            latest.request_number AS latest_service_id,
            latest.status AS latest_service_status,
            latest.service_name AS latest_service_title,
            latest.site_location AS latest_service_location,
            latest.preferred_date AS latest_service_date,
            latest.preferred_time AS latest_service_time,
            latest.created_at AS latest_service_at
       FROM public.users u
       JOIN public.roles role ON role.id = u.role_id
       LEFT JOIN public.companies co ON co.id = u.company_id
       LEFT JOIN service_totals totals ON totals.user_id = u.id
       LEFT JOIN latest_services latest ON latest.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const user = registrationResult.rows[0];
  if (!user) return null;

  const [
    companyRows,
    sitesResult,
    devicesResult,
    serviceRequests,
    serviceSelections,
    serviceEvents,
    repairTickets,
    repairEvents,
    projectRequests,
    projectEvents,
    contracts,
    amcEvents,
    orderRows,
    orderEvents,
    supportRows,
  ] = await Promise.all([
    servicePool.query(
      `SELECT company.company_name, company.industry, company.city, company.state,
              company.country, company.address, company.status
         FROM public.companies company
        WHERE company.id = (SELECT company_id FROM public.users WHERE id = $1)
           OR EXISTS (
             SELECT 1 FROM public.company_members member
              WHERE member.user_id = $1 AND member.company_id = company.id
           )
        ORDER BY company.company_name`,
      [userId],
    ),
    servicePool.query(
      `SELECT site.site_name, site.address, site.city, site.site_type, site.status,
              site.is_primary,
              (SELECT COUNT(*)::int FROM public.devices device WHERE device.site_id = site.id) AS device_count
         FROM public.sites site
        WHERE site.company_id IN (
          SELECT company_id FROM public.company_members WHERE user_id = $1
          UNION
          SELECT company_id FROM public.users WHERE id = $1 AND company_id IS NOT NULL
        )
        ORDER BY site.is_primary DESC, site.site_name`,
      [userId],
    ),
    servicePool.query(
      `SELECT device.device_type, device.manufacturer, device.model, device.location,
              site.site_name, device.created_at
         FROM public.devices device
         JOIN public.sites site ON site.id = device.site_id
        WHERE site.company_id IN (
          SELECT company_id FROM public.company_members WHERE user_id = $1
          UNION
          SELECT company_id FROM public.users WHERE id = $1 AND company_id IS NOT NULL
        )
        ORDER BY device.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT request.id, request.request_number, category.name AS category_name,
              request.status, request.priority, request.preferred_date, request.preferred_time,
              request.assigned_engineer_name, request.submitted_at, request.completed_at,
              request.created_at, request.updated_at,
              CONCAT_WS(', ', site.site_name, site.address, site.city) AS location
         FROM public.service_requests request
         JOIN public.customers customer ON customer.id = request.customer_id
         LEFT JOIN public.service_categories category ON category.id = request.category_id
         LEFT JOIN public.sites site ON site.id = request.site_id
        WHERE customer.user_id = $1
        ORDER BY request.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT selection.request_id, step.title AS step_title, option.name AS option_name
         FROM public.service_request_selections selection
         JOIN public.service_steps step ON step.id = selection.step_id
         JOIN public.service_options option ON option.id = selection.option_id
        WHERE selection.request_id IN (
          SELECT request.id
            FROM public.service_requests request
            JOIN public.customers customer ON customer.id = request.customer_id
           WHERE customer.user_id = $1
        )
        ORDER BY selection.sort_order`,
      [userId],
    ),
    servicePool.query(
      `SELECT history.service_request_id AS item_id, history.new_status AS status,
              history.remarks AS note, history.changed_at AS at
         FROM public.service_request_status_history history
         JOIN public.service_requests request ON request.id = history.service_request_id
         JOIN public.customers customer ON customer.id = request.customer_id
        WHERE customer.user_id = $1
        ORDER BY history.changed_at`,
      [userId],
    ),
    servicePool.query(
      `SELECT ticket.id, ticket.ticket_number, ticket.service_type, ticket.priority,
              ticket.requested_turnaround, ticket.issue_description, ticket.symptoms,
              ticket.error_details, ticket.status, ticket.submitted_at, ticket.completed_at,
              ticket.created_at, ticket.updated_at, device.device_type, device.manufacturer,
              device.model, site.site_name, site.address AS site_address, site.city AS site_city
         FROM public.repair_tickets ticket
         JOIN public.customers customer ON customer.id = ticket.customer_id
         LEFT JOIN public.devices device ON device.id = ticket.device_id
         LEFT JOIN public.sites site ON site.id = ticket.site_id
        WHERE customer.user_id = $1
        ORDER BY ticket.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT history.repair_ticket_id AS item_id, history.new_status AS status,
              history.remarks AS note, history.created_at AS at
         FROM public.repair_status_history history
         JOIN public.repair_tickets ticket ON ticket.id = history.repair_ticket_id
         JOIN public.customers customer ON customer.id = ticket.customer_id
        WHERE customer.user_id = $1
        ORDER BY history.created_at`,
      [userId],
    ),
    servicePool.query(
      `SELECT request.id, request.request_number, request.title, request.description,
              request.requirements, request.preferred_timeline, request.budget_amount,
              request.budget_currency, request.status, request.submitted_at,
              request.completed_at, request.created_at, request.updated_at,
              category.name AS category_name, project_type.name AS project_type,
              CONCAT_WS(', ', site.site_name, site.address, site.city) AS location
         FROM public.project_requests request
         JOIN public.customers customer ON customer.id = request.customer_id
         LEFT JOIN public.project_categories category ON category.id = request.category_id
         LEFT JOIN public.project_types project_type ON project_type.id = request.project_type_id
         LEFT JOIN public.sites site ON site.id = request.site_id
        WHERE customer.user_id = $1
        ORDER BY request.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT history.project_request_id AS item_id, history.new_status AS status,
              history.remarks AS note, history.changed_at AS at
         FROM public.project_status_history history
         JOIN public.project_requests request ON request.id = history.project_request_id
         JOIN public.customers customer ON customer.id = request.customer_id
        WHERE customer.user_id = $1
        ORDER BY history.changed_at`,
      [userId],
    ),
    servicePool.query(
      `SELECT contract.id, contract.contract_number, contract.contract_type, contract.coverage,
              contract.start_date, contract.end_date, contract.visit_frequency,
              contract.visits_per_year, contract.next_visit_date, contract.preferred_visit_time,
              contract.status, contract.assigned_engineer_name, contract.assigned_service_team,
              contract.created_at, contract.updated_at,
              CONCAT_WS(', ', site.site_name, site.address, site.city) AS location
         FROM public.amc_contracts contract
         JOIN public.customers customer ON customer.id = contract.customer_id
         LEFT JOIN public.sites site ON site.id = contract.site_id
        WHERE customer.user_id = $1
        ORDER BY contract.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT history.amc_contract_id AS item_id, history.new_status AS status,
              history.remarks AS note, history.changed_at AS at
         FROM public.amc_status_history history
         JOIN public.amc_contracts contract ON contract.id = history.amc_contract_id
         JOIN public.customers customer ON customer.id = contract.customer_id
        WHERE customer.user_id = $1 AND history.amc_contract_id IS NOT NULL
        ORDER BY history.changed_at`,
      [userId],
    ),
    servicePool.query(
      `SELECT order_row.id, order_row.order_number, order_row.status, order_row.currency,
              order_row.subtotal, order_row.delivery_fee, order_row.total,
              order_row.payment_mode, order_row.created_at,
              payment.status AS payment_status, payment.provider AS payment_provider,
              payment.amount AS payment_amount
         FROM public.orders order_row
         LEFT JOIN LATERAL (
           SELECT status, provider, amount
             FROM public.payments
            WHERE order_id = order_row.id
            ORDER BY created_at DESC
            LIMIT 1
         ) payment ON TRUE
        WHERE order_row.user_id = $1
        ORDER BY order_row.created_at DESC`,
      [userId],
    ),
    servicePool.query(
      `SELECT history.order_id AS item_id, history.status, history.note, history.created_at AS at
         FROM public.order_status_history history
         JOIN public.orders order_row ON order_row.id = history.order_id
        WHERE order_row.user_id = $1
        ORDER BY history.created_at`,
      [userId],
    ),
    servicePool.query(
      `SELECT subject, status, created_at
         FROM public.support_requests
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    ),
  ]);

  const registration = buildServiceRegistrations([user])[0];
  const serviceSelectionsByRequest = groupBy(serviceSelections.rows, 'request_id');
  const serviceTimeline = serviceTimelineRows(serviceEvents.rows, 'item_id');
  const repairTimeline = serviceTimelineRows(repairEvents.rows, 'item_id');
  const projectTimeline = serviceTimelineRows(projectEvents.rows, 'item_id');
  const amcTimeline = serviceTimelineRows(amcEvents.rows, 'item_id');
  const orderTimeline = serviceTimelineRows(orderEvents.rows, 'item_id');
  const activity = [
    ...serviceRequests.rows.map((request) => ({
      id: String(request.id),
      kind: 'service',
      reference: text(request.request_number),
      title: text(request.category_name) || 'Service request',
      status: text(request.status) || 'unknown',
      priority: text(request.priority),
      description: null,
      location: text(request.location),
      createdAt: asIso(request.submitted_at || request.created_at),
      scheduledAt: request.preferred_date
        ? `${asDateOnly(request.preferred_date)}${request.preferred_time ? ` ${request.preferred_time}` : ''}`
        : null,
      completedAt: asIso(request.completed_at),
      dueAt: null,
      assignedTo: text(request.assigned_engineer_name),
      amount: null,
      currency: null,
      details: (serviceSelectionsByRequest.get(String(request.id)) || [])
        .map((selection) => [text(selection.step_title), text(selection.option_name)].filter(Boolean).join(': '))
        .filter(Boolean),
      timeline: serviceTimeline.get(String(request.id)) || [],
    })),
    ...repairTickets.rows.map((ticket) => ({
      id: String(ticket.id),
      kind: 'repair',
      reference: text(ticket.ticket_number),
      title: [text(ticket.service_type), text(ticket.device_type), text(ticket.manufacturer), text(ticket.model)]
        .filter(Boolean).join(' · ') || 'Repair ticket',
      status: text(ticket.status) || 'unknown',
      priority: text(ticket.priority),
      description: shortText(ticket.issue_description || ticket.symptoms || ticket.error_details),
      location: [text(ticket.site_name), text(ticket.site_address || ticket.site_city)].filter(Boolean).join(', ') || null,
      createdAt: asIso(ticket.submitted_at || ticket.created_at),
      scheduledAt: null,
      completedAt: asIso(ticket.completed_at),
      dueAt: null,
      assignedTo: null,
      amount: null,
      currency: null,
      details: [text(ticket.requested_turnaround)].filter(Boolean),
      timeline: repairTimeline.get(String(ticket.id)) || [],
    })),
    ...projectRequests.rows.map((request) => ({
      id: String(request.id),
      kind: 'project',
      reference: text(request.request_number),
      title: text(request.title) || text(request.project_type) || 'Project request',
      status: text(request.status) || 'unknown',
      priority: null,
      description: shortText(request.description || request.requirements),
      location: text(request.location),
      createdAt: asIso(request.submitted_at || request.created_at),
      scheduledAt: text(request.preferred_timeline),
      completedAt: asIso(request.completed_at),
      dueAt: null,
      assignedTo: null,
      amount: optionalNumber(request.budget_amount),
      currency: text(request.budget_currency),
      details: [text(request.category_name), text(request.project_type)].filter(Boolean),
      timeline: projectTimeline.get(String(request.id)) || [],
    })),
    ...contracts.rows.map((contract) => ({
      id: String(contract.id),
      kind: 'amc',
      reference: text(contract.contract_number),
      title: `${text(contract.contract_type) || 'AMC'} · ${text(contract.coverage) || 'Service contract'}`,
      status: text(contract.status) || 'unknown',
      priority: null,
      description: null,
      location: text(contract.location),
      createdAt: asIso(contract.created_at),
      scheduledAt: contract.next_visit_date ? asDateOnly(contract.next_visit_date) : null,
      completedAt: null,
      dueAt: contract.end_date ? asDateOnly(contract.end_date) : null,
      assignedTo: text(contract.assigned_engineer_name) || text(contract.assigned_service_team),
      amount: null,
      currency: null,
      details: [
        text(contract.visit_frequency),
        optionalNumber(contract.visits_per_year) === null ? null : `${contract.visits_per_year} visits/year`,
        text(contract.preferred_visit_time),
      ].filter(Boolean),
      timeline: amcTimeline.get(String(contract.id)) || [],
    })),
  ].sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0));

  const orders = orderRows.rows.map((order) => ({
    id: String(order.id),
    orderNumber: text(order.order_number) || String(order.id),
    status: text(order.status) || 'unknown',
    currency: text(order.currency) || 'INR',
    subtotal: numeric(order.subtotal),
    deliveryFee: numeric(order.delivery_fee),
    total: numeric(order.total),
    paymentMode: text(order.payment_mode),
    paymentStatus: text(order.payment_status),
    paymentProvider: text(order.payment_provider),
    paymentAmount: optionalNumber(order.payment_amount),
    createdAt: asIso(order.created_at),
    timeline: orderTimeline.get(String(order.id)) || [],
  }));
  const orderActivity = orders.map((order) => ({ createdAt: order.createdAt, total: order.total }));
  const companies = companyRows.rows.map((company) => ({
    name: text(company.company_name) || 'Company',
    industry: text(company.industry),
    location: [text(company.city), text(company.state), text(company.country)].filter(Boolean).join(', ') || text(company.address),
    status: text(company.status),
  }));

  return {
    registration,
    account: {
      avatarUrl: text(user.avatar_url),
      secondaryPhone: text(user.secondary_phone),
      emailVerified: user.email_verified === null || user.email_verified === undefined
        ? null : boolean(user.email_verified),
      phoneVerified: user.phone_verified === null || user.phone_verified === undefined
        ? null : boolean(user.phone_verified),
      lastLoginAt: asIso(user.last_login_at),
      updatedAt: asIso(user.updated_at),
      currentWork: null,
      partnerSince: null,
      travelRadiusKm: null,
      onboarding: null,
      payoutProfileConfigured: null,
      vehicleVerification: null,
      companies,
      sites: sitesResult.rows.map((site) => ({
        name: text(site.site_name) || 'Site',
        address: text(site.address),
        city: text(site.city),
        type: text(site.site_type),
        status: text(site.status),
        primary: boolean(site.is_primary),
        deviceCount: numeric(site.device_count),
      })),
      devices: devicesResult.rows.map((device) => ({
        type: text(device.device_type),
        manufacturer: text(device.manufacturer),
        model: text(device.model),
        location: text(device.location),
        site: text(device.site_name),
        createdAt: asIso(device.created_at),
      })),
      documents: [],
    },
    activity,
    statusBreakdown: statusCounts(activity),
    monthlyActivity: activityByMonth(
      activity,
      orderActivity.map((item) => ({ at: item.createdAt, amount: item.total })),
    ),
    financialSummary: summarizeOrders(orders),
    earnings: [],
    orders,
    supportRequests: supportRows.rows.map((request) => ({
      subject: text(request.subject) || 'Support request',
      status: text(request.status) || 'unknown',
      createdAt: asIso(request.created_at),
    })),
  };
}

function createPlatformDirectory(connections = { providerDb, servicePool }) {
  return {
    async listRegistrations() {
      const [providerUsers, applications, activeJobs, jobCounts, earnings, serviceUsers] = await Promise.all([
        connections.providerDb.query(
          `SELECT id, mobile, email, role, status, full_name, business_name, address,
                  years_experience, qualification, qualification_details, specialization_details,
                  service_areas, rating, jobs_completed, is_online, is_busy, reference_id, created_at
             FROM users
            WHERE role IS NOT NULL AND role <> 'admin'
            ORDER BY created_at DESC`,
        ),
        connections.providerDb.query(
          `SELECT id, user_id, partner_role, status, reference_id, service_areas,
                  professional_details, categories, specializations, submitted_at, created_at
             FROM partner_applications
            ORDER BY id DESC`,
        ),
        connections.providerDb.query(
          `SELECT id, reference_id, assigned_partner_id, title, status, stage, site_address,
                  site_area, scheduled_at, sla_due_at, estimated_drive_minutes, created_at, updated_at
             FROM jobs
            WHERE assigned_partner_id IS NOT NULL AND status IN ('accepted', 'in_progress')
            ORDER BY updated_at DESC, id DESC`,
        ),
        connections.providerDb.query(
          `SELECT assigned_partner_id, COUNT(*) AS total_services
             FROM jobs
            WHERE assigned_partner_id IS NOT NULL
            GROUP BY assigned_partner_id`,
        ),
        connections.providerDb.query(
          `SELECT partner_id, status, net_amount FROM earnings`,
        ),
        connections.servicePool.query(
          `WITH service_totals AS (
             SELECT customer.user_id,
                    COUNT(request.id)::int AS total_services,
                    COUNT(request.id) FILTER (WHERE request.status = 'completed')::int AS completed_services
               FROM public.customers customer
               LEFT JOIN public.service_requests request ON request.customer_id = customer.id
              GROUP BY customer.user_id
           ), latest_services AS (
             SELECT DISTINCT ON (customer.user_id)
                    customer.user_id, request.request_number, request.status,
                    category.name AS service_name,
                    CONCAT_WS(', ', site.site_name, site.address) AS site_location,
                    request.preferred_date, request.preferred_time, request.created_at
               FROM public.customers customer
               JOIN public.service_requests request ON request.customer_id = customer.id
               LEFT JOIN public.service_categories category ON category.id = request.category_id
               LEFT JOIN public.sites site ON site.id = request.site_id
              ORDER BY customer.user_id, request.created_at DESC
           )
           SELECT u.id, u.name AS full_name, u.email, u.phone, role.name AS role, u.status, u.created_at,
                  co.company_name, co.city AS company_city,
                  COALESCE(totals.total_services, 0) AS total_services,
                  COALESCE(totals.completed_services, 0) AS completed_services,
                  latest.request_number AS latest_service_id,
                  latest.status AS latest_service_status,
                  latest.service_name AS latest_service_title,
                  latest.site_location AS latest_service_location,
                  latest.preferred_date AS latest_service_date,
                  latest.preferred_time AS latest_service_time,
                  latest.created_at AS latest_service_at
             FROM public.users u
             JOIN public.roles role ON role.id = u.role_id
             LEFT JOIN public.companies co ON co.id = u.company_id
             LEFT JOIN service_totals totals ON totals.user_id = u.id
             LEFT JOIN latest_services latest ON latest.user_id = u.id
            ORDER BY u.created_at DESC`,
        ),
      ]);

      const partners = buildProviderRegistrations(
        providerUsers,
        applications,
        activeJobs,
        jobCounts,
        earnings,
      );
      return [...partners, ...buildServiceRegistrations(serviceUsers.rows)]
        .sort((left, right) => (Date.parse(right.registeredAt || '') || 0) -
          (Date.parse(left.registeredAt || '') || 0));
    },
    async getRegistrationDetails(id) {
      const match = /^(energy-hub|service-admin):(.+)$/.exec(String(id));
      if (!match) return null;
      if (match[1] === 'energy-hub') {
        if (!/^\d+$/.test(match[2])) return null;
        return getProviderDetails(connections, match[2]);
      }
      return getServiceAdminDetails(connections, match[2]);
    },
  };
}

module.exports = {
  createPlatformDirectory,
  buildProviderRegistrations,
  buildServiceRegistrations,
};
