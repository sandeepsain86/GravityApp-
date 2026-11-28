const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanFaultDescription,
  getPartners,
  getProjects,
  getRepairs,
  mapJob,
  repairStage,
} = require('./operations-directory');

test('project reader preserves canonical status and maps real request, detail, and milestone fields', async () => {
  let queryText = '';
  const result = await getProjects(async (sql) => {
    queryText = sql;
    return { rows: [{
      id: 'project-uuid',
      request_number: 'PRJ-10',
      title: 'Plant control upgrade',
      estimated_scope: 'Three control panels',
      description: 'Replace legacy controls',
      requirements: 'PLC integration',
      preferred_timeline: 'Q4 2026',
      budget_amount: '1250000.00',
      budget_currency: 'INR',
      status: 'in_progress',
      created_at: '2026-01-01T00:00:00.000Z',
      submitted_at: '2026-01-02T00:00:00.000Z',
      completed_at: null,
      company_name: 'Example Industries',
      site_name: 'Main plant',
      category_name: 'Automation Projects',
      project_type_name: 'New PLC System',
      details: { material_hold: 'true', project_code: 'PX-1' },
      milestones: [{
        id: 'milestone-1',
        title: 'Panel installation',
        sequence: 1,
        status: 'in_progress',
        plannedStart: '2026-01-10',
        dueDate: '2026-02-01',
        completedAt: null,
        clientSignoffStatus: 'pending',
        leadEngineerName: 'Engineer A',
        budgetAmount: 500000,
        materialCost: 125000,
        partnerPayout: 50000,
        billedAmount: 200000,
      }],
      status_history: [{
        oldStatus: 'approved',
        newStatus: 'in_progress',
        note: 'Work started',
        changedAt: '2026-02-01T00:00:00.000Z',
      }],
    }] };
  });
  assert.match(queryText, /project_milestones/);
  assert.match(queryText, /project_status_history|project_request_details/);
  assert.equal(result.items[0].id, 'PRJ-10');
  assert.equal(result.items[0].requestId, 'project-uuid');
  assert.equal(result.items[0].status, 'in_progress');
  assert.equal(result.items[0].description, 'Replace legacy controls');
  assert.equal(result.items[0].currency, 'INR');
  assert.deepEqual(result.items[0].details, { material_hold: 'true', project_code: 'PX-1' });
  assert.equal(result.items[0].milestones[0].clientSignoffStatus, 'pending');
  assert.equal(result.items[0].statusHistory[0].note, 'Work started');
});

test('job faults render JSON arrays as readable text and hide generic demo placeholders', () => {
  assert.equal(
    cleanFaultDescription('["Overcurrent",{"label":"Cooling fan","description":"bearing noise"}]'),
    'Overcurrent · Cooling fan: bearing noise',
  );
  assert.equal(cleanFaultDescription('Demo job'), '');
  assert.equal(cleanFaultDescription('Motor trips under load'), 'Motor trips under load');
});

test('open job value uses stored customer quote or stored base and service charges only', () => {
  const activity = new Map();
  const baseRow = {
    id: 8,
    reference_id: 'JOB-8',
    job_type: 'service',
    target_role: 'service_partner',
    status: 'open',
    urgency: 'high',
    total_bill: 0,
    base_pay: 450,
    service_charge: 50,
    description: 'Inspection required',
  };
  const estimated = mapJob(baseRow, activity);
  assert.equal(estimated.amount, 500);
  assert.equal(estimated.amountSource, 'base pay and service charge');

  const quoted = mapJob({ ...baseRow, total_bill: 1250 }, activity);
  assert.equal(quoted.amount, 1250);
  assert.equal(quoted.amountSource, 'customer quote');

  const unpriced = mapJob({ ...baseRow, base_pay: 0, service_charge: 0 }, activity);
  assert.equal(unpriced.amount, 0);
  assert.equal(unpriced.amountSource, null);
});

test('job coordinates older than 90 minutes are retained as stale timestamps, not live locations', () => {
  const updatedAt = new Date(Date.now() - 91 * 60_000).toISOString();
  const job = mapJob({
    id: 8,
    reference_id: 'JOB-8',
    status: 'in_progress',
    live_latitude: 28.6139,
    live_longitude: 77.209,
    live_location_updated_at: updatedAt,
  }, new Map());

  assert.equal(job.liveLocation, null);
  assert.equal(job.lastLocationAt, updatedAt);
});

test('partner query avoids JSON operators and application-profile joins for text-backed fields', async () => {
  let queryText = '';
  const result = await getPartners(async (sql) => {
    queryText = sql;
    return [
      {
        id: 8,
        role: 'service_partner',
        status: 'active',
        years_experience: '7 years',
        specialization_details: '["Electrical"]',
      },
      {
        id: 9,
        role: 'repairing_partner',
        status: 'pending',
        years_experience: null,
        specialization_details: 'legacy value',
      },
    ];
  });
  assert.doesNotMatch(queryText, /->>|professional_details|partner_applications/);
  assert.match(queryText, /partner\.years_experience/);
  assert.match(queryText, /partner\.specialization_details/);
  assert.equal(result.items[0].experienceYears, '7 years');
  assert.deepEqual(result.items[0].specializations, ['Electrical']);
  assert.equal(result.items[1].experienceYears, null);
});

test('repair reader maps persisted stages and returns ticket history and available device facts', async () => {
  const result = await getRepairs(async (sql) => {
    if (sql.includes('FROM public.repair_tickets')) {
      return { rows: [{
        id: 'repair-1',
        ticket_number: 'RPR-1',
        status: 'estimate_required',
        repair_scope: 'workshop',
        service_type: 'component_repair',
        priority: 'urgent',
        submitted_at: '2026-03-01T00:00:00.000Z',
        created_at: '2026-02-28T00:00:00.000Z',
        updated_at: '2026-03-02T00:00:00.000Z',
        device_manufacturer: 'Acme',
        device_model: 'VFD-10',
        device_serial_number: 'SN-1',
        device_asset_number: 'ASSET-1',
        device_location: 'Plant 1',
        company_name: 'Acme Industries',
        site_name: 'Plant 1',
        amc_status: 'active',
        amc_end_date: '2027-01-01',
        issue_description: 'Motor trips under load',
        symptoms: 'Overcurrent',
        error_details: 'F0001',
      }] };
    }
    return { rows: [{
      repair_ticket_id: 'repair-1',
      new_status: 'diagnosis',
      remarks: 'GH_REPAIR_METADATA:{"benchPartnerId":"partner-1","benchPartnerName":"Bench One","partRequests":[{"sku":"PART-1","name":"Power module","quantity":2,"status":"requested","requestedAt":"2026-03-01T01:00:00.000Z"}]}\nDiagnosis started',
      created_at: '2026-03-01T01:00:00.000Z',
    }] };
  });

  assert.equal(result.items[0].ticketNumber, 'RPR-1');
  assert.equal(result.items[0].stage, 'quote_approval');
  assert.equal(result.items[0].device, 'Acme VFD-10');
  assert.equal(result.items[0].serialNumber, 'SN-1');
  assert.equal(result.items[0].clientName, 'Acme Industries');
  assert.equal(result.items[0].amcStatus, 'active');
  assert.equal(result.items[0].fault, 'F0001');
  assert.equal(result.items[0].cost, null);
  assert.equal(result.items[0].partner, null);
  assert.equal(result.items[0].benchPartnerName, 'Bench One');
  assert.equal(result.items[0].partRequests[0].status, 'requested');
  assert.equal(result.items[0].testRecord, false);
  assert.equal(result.items[0].history[0].status, 'diagnosis');
  assert.equal(repairStage('ready'), 'qc_passed');
  assert.equal(repairStage('returned'), 'delivered');
});

test('repair reader marks workshop test-maker tickets for the default UI filter', async () => {
  const result = await getRepairs(async (sql) => ({
    rows: sql.includes('FROM public.repair_tickets')
      ? [{
        id: 'test-repair',
        ticket_number: 'RPR-TEST-1',
        status: 'received',
        device_manufacturer: 'Test Maker',
        device_model: 'Panel A',
      }]
      : [],
  }));

  assert.equal(result.items[0].testRecord, true);
});

test('repair reader hides generated dummy device text from the default operational view', async () => {
  const result = await getRepairs(async (sql) => ({
    rows: sql.includes('FROM public.repair_tickets')
      ? [{
        id: 'dummy-repair',
        ticket_number: 'RPR-2026-000030',
        status: 'received',
        device_manufacturer: 'Dhdrhdh',
        device_model: 'HDDHDHHDD',
      }]
      : [],
  }));

  assert.equal(result.items[0].testRecord, true);
});
