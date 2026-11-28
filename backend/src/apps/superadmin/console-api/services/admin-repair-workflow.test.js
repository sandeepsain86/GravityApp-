const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminRepairWorkflowService } = require('./admin-repair-workflow');

function workflowHarness(status = 'diagnosis', options = {}) {
  const queries = [];
  const ticket = { id: 'repair-id', ticket_number: 'RPR-1', status };
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('SELECT id, ticket_number, status')) return { rows: options.ticketRows ?? [{ ...ticket }] };
      if (sql.includes('FROM energy_provider.users')) {
        return { rows: options.partnerRows ?? [{ id: 'partner-1', business_name: 'Verified Bench' }] };
      }
      if (sql.includes('FROM energy_provider.inventory_items')) {
        return { rows: options.inventoryRows ?? [{ sku: 'PART-1', name: 'Power module' }] };
      }
      if (sql.includes('SELECT remarks')) return { rows: [] };
      if (sql.includes('UPDATE public.repair_tickets')) {
        if (sql.includes('SET status = $2')) ticket.status = values[1];
        return { rows: [{ ...ticket, updated_at: '2026-03-01T00:00:00.000Z' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  return { service: createAdminRepairWorkflowService(pool), queries, ticket };
}

test('repair stage transitions persist status and an auditable history row atomically', async () => {
  const { service, queries, ticket } = workflowHarness();
  const result = await service.transitionStage(
    'RPR-1',
    'quote_approval',
    'Diagnosis completed',
    { estimatedCost: 2500 },
    { name: 'Admin', email: 'admin@example.com' },
  );

  assert.equal(result.status, 'estimate_required');
  assert.equal(result.stage, 'quote_approval');
  assert.equal(ticket.status, 'estimate_required');
  assert.equal(queries[0].sql, 'BEGIN');
  assert.match(queries[1].sql, /FOR UPDATE/);
  assert.match(queries[3].sql, /INSERT INTO public\.repair_status_history/);
  assert.deepEqual(queries[3].values.slice(1, 3), ['diagnosis', 'estimate_required']);
  assert.match(queries[3].values[3], /Updated by Superadmin Admin/);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('repair cannot start before the customer approval status is persisted', async () => {
  const { service, queries } = workflowHarness('estimate_required');

  await assert.rejects(
    service.transitionStage('RPR-1', 'repairing', '', { name: 'Admin', email: 'admin@example.com' }),
    { statusCode: 409, message: 'Repair cannot start until the customer approves the estimate.' },
  );
  assert.equal(queries.some(({ sql }) => sql.includes('UPDATE public.repair_tickets')), false);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('repair can start after customer approval and QC completion requires a note', async () => {
  const { service, ticket } = workflowHarness('approved');
  const result = await service.transitionStage(
    'RPR-1',
    'repairing',
    '',
    { name: 'Admin', email: 'admin@example.com' },
  );
  assert.equal(result.status, 'repair_in_progress');
  assert.equal(ticket.status, 'repair_in_progress');

  const qcHarness = workflowHarness('repair_in_progress');
  await assert.rejects(
    qcHarness.service.transitionStage(
      'RPR-1',
      'qc_passed',
      '',
      { name: 'Admin', email: 'admin@example.com' },
    ),
    { statusCode: 400, message: 'A QC note is required before marking the repair as QC passed.' },
  );
  assert.equal(qcHarness.queries.length, 0);
});

test('workshop assignment and part requests persist without changing ticket stage or stock', async () => {
  const { service, queries, ticket } = workflowHarness('received');
  const result = await service.updateWorkshopDetails(
    'RPR-1',
    {
      benchPartnerId: 'partner-1',
      partRequest: { sku: 'PART-1', quantity: 2 },
    },
    { name: 'Admin', email: 'admin@example.com' },
  );

  assert.equal(result.stage, 'workshop_update');
  assert.equal(ticket.status, 'received');
  assert.equal(queries.some(({ sql }) => sql.includes('SET quantity = quantity -')), false);
  const historyInsert = queries.find(({ sql }) => sql.includes('INSERT INTO public.repair_status_history'));
  assert.match(historyInsert.sql, /VALUES\s+\(\$1,\s*\$2,\s*\$2,\s*NULL,\s*\$3\)/);
  assert.equal(historyInsert.values[1], 'received');
  assert.match(historyInsert.values[2], /"benchPartnerName":"Verified Bench"/);
  assert.match(historyInsert.values[2], /"sku":"PART-1","name":"Power module","quantity":2,"status":"requested"/);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('workshop assignment rejects a partner not in the active verified roster', async () => {
  const { service, queries } = workflowHarness('received', { partnerRows: [] });
  await assert.rejects(
    service.updateWorkshopDetails(
      'RPR-1',
      { benchPartnerId: 'unverified-partner' },
      { name: 'Admin', email: 'admin@example.com' },
    ),
    { statusCode: 409, message: 'Choose an active, verified service or repair partner.' },
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('workshop updates are blocked after a repair is closed', async () => {
  const { service, queries } = workflowHarness('returned');

  await assert.rejects(
    service.updateWorkshopDetails(
      'RPR-1',
      { benchPartnerId: 'partner-1' },
      { name: 'Admin', email: 'admin@example.com' },
    ),
    { statusCode: 409, message: 'Workshop details cannot be changed for a closed repair ticket.' },
  );
  assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO public.repair_status_history')), false);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('bulk repair assignment locks tickets and records partner ownership without changing stages', async () => {
  const { service, queries, ticket } = workflowHarness('received');
  const result = await service.assignPartnerToRepairs(
    ['RPR-1'],
    'partner-1',
    { name: 'Admin', email: 'admin@example.com' },
  );

  assert.equal(result.repairs.length, 1);
  assert.equal(result.partnerName, 'Verified Bench');
  assert.equal(ticket.status, 'received');
  assert.ok(queries.some(({ sql }) => /ANY\(\$1::text\[\]\).*FOR UPDATE/s.test(sql)));
  const historyInsert = queries.find(({ sql }) => sql.includes('INSERT INTO public.repair_status_history'));
  assert.match(historyInsert.values[2], /"benchPartnerId":"partner-1"/);
  assert.match(historyInsert.values[2], /Workshop partner assigned in bulk/);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});
