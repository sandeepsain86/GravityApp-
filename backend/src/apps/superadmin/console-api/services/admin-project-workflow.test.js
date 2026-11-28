const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdminProjectWorkflow } = require('./admin-project-workflow');

function createPool(handler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return handler(sql, values);
    },
    release() {},
  };
  return {
    calls,
    connect: async () => client,
    query: client.query.bind(client),
  };
}

const actor = { name: 'Super Admin', email: 'admin@example.test' };

test('project status transitions persist status and audit history atomically', async () => {
  const pool = createPool((sql) => {
    if (sql.includes('SELECT id, request_number, status')) {
      return { rows: [{ id: 'project-1', request_number: 'PRJ-1', status: 'submitted' }] };
    }
    if (sql.includes('UPDATE public.project_requests')) {
      return { rows: [{ id: 'project-1', request_number: 'PRJ-1', status: 'under_review' }] };
    }
    return { rows: [] };
  });
  const workflow = createAdminProjectWorkflow(pool);

  const result = await workflow.transitionStatus('PRJ-1', 'under_review', 'Initial review', actor);

  assert.equal(result.status, 'under_review');
  assert.ok(pool.calls.some((call) => call.sql.includes('INSERT INTO public.project_status_history') &&
    call.values[3].includes('admin@example.test')));
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('project workflow rejects invalid status jumps and rolls back', async () => {
  const pool = createPool((sql) => sql.includes('SELECT id, request_number, status')
    ? { rows: [{ id: 'project-1', request_number: 'PRJ-1', status: 'submitted' }] }
    : { rows: [] });
  const workflow = createAdminProjectWorkflow(pool);

  await assert.rejects(
    workflow.transitionStatus('PRJ-1', 'completed', '', actor),
    (error) => error.statusCode === 409,
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('project cannot close until its milestones and client sign-offs are complete', async () => {
  const pool = createPool((sql) => {
    if (sql.includes('SELECT id, request_number, status')) {
      return { rows: [{ id: 'project-1', request_number: 'PRJ-1', status: 'in_progress' }] };
    }
    if (sql.includes('SELECT COUNT(*)::int')) return { rows: [{ count: 1 }] };
    return { rows: [] };
  });
  const workflow = createAdminProjectWorkflow(pool);

  await assert.rejects(
    workflow.transitionStatus('PRJ-1', 'completed', '', actor),
    (error) => error.statusCode === 409 && /milestones/i.test(error.message),
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.calls.some((call) => call.sql.includes('UPDATE public.project_requests')), false);
});

test('milestone creation validates calendar dates before persisting a numbered milestone', async () => {
  const pool = createPool((sql) => {
    if (sql.includes('SELECT id, request_number, status')) {
      return { rows: [{ id: 'project-1', request_number: 'PRJ-1', status: 'in_progress' }] };
    }
    if (sql.includes('INSERT INTO public.project_milestones')) {
      return { rows: [{ id: 'milestone-1', title: 'Install equipment', sequence: 2 }] };
    }
    return { rows: [] };
  });
  const workflow = createAdminProjectWorkflow(pool);

  const result = await workflow.createMilestone('PRJ-1', {
    title: 'Install equipment',
    plannedStart: '2026-03-01',
    dueDate: '2026-03-15',
    budgetAmount: 125000,
  }, actor);

  assert.equal(result.sequence, 2);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  await assert.rejects(
    workflow.createMilestone('PRJ-1', {
      title: 'Invalid date',
      plannedStart: '2026-02-31',
      dueDate: '2026-03-15',
    }, actor),
    (error) => error.statusCode === 400,
  );
});

test('milestone update validates merged dates and allows partial cost updates', async () => {
  const pool = createPool((sql) => {
    if (sql.includes('SELECT milestone.*')) {
      return { rows: [{
        id: 'milestone-1',
        project_status: 'in_progress',
        title: 'Install equipment',
        status: 'in_progress',
        planned_start: '2026-03-10',
        due_date: '2026-03-20',
        client_signoff_status: 'pending',
        lead_engineer_name: 'Engineer A',
        budget_amount: '125000.00',
        material_cost: null,
        partner_payout: null,
        billed_amount: null,
      }] };
    }
    if (sql.includes('UPDATE public.project_milestones')) {
      return { rows: [{ id: 'milestone-1', material_cost: '30000.00' }] };
    }
    return { rows: [] };
  });
  const workflow = createAdminProjectWorkflow(pool);

  await assert.rejects(
    workflow.updateMilestone('PRJ-1', 'milestone-1', { dueDate: '2026-03-01' }),
    (error) => error.statusCode === 400,
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');

  const result = await workflow.updateMilestone('PRJ-1', 'milestone-1', { materialCost: 30000 });
  assert.equal(result.id, 'milestone-1');
  const update = pool.calls.find((call) => call.sql.includes('UPDATE public.project_milestones'));
  assert.equal(update.values[1], 30000);
  assert.equal(update.values[2], 'in_progress');
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('milestones cannot be modified after a project is closed', async () => {
  const pool = createPool((sql) => sql.includes('SELECT milestone.*')
    ? { rows: [{ id: 'milestone-1', project_status: 'completed' }] }
    : { rows: [] });
  const workflow = createAdminProjectWorkflow(pool);

  await assert.rejects(
    workflow.updateMilestone('PRJ-1', 'milestone-1', { status: 'pending' }),
    (error) => error.statusCode === 409,
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('completed milestones cannot be moved back to an unfinished status', async () => {
  const pool = createPool((sql) => sql.includes('SELECT milestone.*')
    ? { rows: [{ id: 'milestone-1', project_status: 'in_progress', status: 'completed' }] }
    : { rows: [] });
  const workflow = createAdminProjectWorkflow(pool);

  await assert.rejects(
    workflow.updateMilestone('PRJ-1', 'milestone-1', { status: 'in_progress' }),
    (error) => error.statusCode === 409,
  );
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});
