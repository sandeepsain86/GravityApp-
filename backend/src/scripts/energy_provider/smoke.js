/**
 * End-to-end smoke test for the marketplace workflows.
 *
 * Run with:  node scripts/smoke.js
 *
 * The test runs against a throwaway SQLite database and exercises job
 * acceptance (including the double-accept guard), busy-state rollback, the
 * five step field workflow, delivery evidence, earnings and dashboard
 * aggregation, and PII masking.
 */

const { db, state, check } = require('./smoke.harness');

const acceptanceCases = require('./smoke.cases.accept');
const marketplaceCases = require('./smoke.cases.market');
const supplierCases = require('./smoke.cases.supplier');
const registrationCases = require('./smoke.cases.registration');

const run = async () => {
  await db.init();
  console.log(`Database ready (${db.describe()})\n`);
  const jobColumns = await db.query('PRAGMA table_info("jobs")');
  check('existing database schema is migrated with appointment time', jobColumns.some((column) => column.name === 'scheduled_at'));
  check('existing database schema is migrated with assignment time', jobColumns.some((column) => column.name === 'assigned_at'));

  await registrationCases();
  const partners = await acceptanceCases();
  const marketPartners = await marketplaceCases(partners);
  await supplierCases(marketPartners);

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  await db.close();

  if (state.failed > 0) process.exit(1);
};

run().catch(async (err) => {
  console.error('\nSmoke test crashed:', err);
  try {
    await db.close();
  } catch (closeError) {
    // The database may already be closed - nothing to do.
  }
  process.exit(1);
});
