/**
 * Shared harness for the end-to-end smoke test.
 *
 * The test runs against a throwaway SQLite database so it never touches the
 * development data.  Every case lives in `smoke.cases.js`.
 *
 * Run with:  node scripts/smoke.js
 */

process.env.DATABASE_URL = 'sqlite://./data/smoke_test.db';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '5098';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { tables } = require('../../db/energy_provider/schema');
const { renderTable } = require('../../db/energy_provider/dialect');

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const DB_FILE = path.join(BACKEND_ROOT, 'data', 'smoke_test.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// Start from a clean database every run.
[DB_FILE, `${DB_FILE}-journal`].forEach((file) => {
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

const legacyJobColumns = { ...tables.jobs.columns };
delete legacyJobColumns.scheduled_at;
const legacyDatabase = new DatabaseSync(DB_FILE);
legacyDatabase.exec(renderTable('sqlite', 'jobs', { ...tables.jobs, columns: legacyJobColumns }));
legacyDatabase.close();

const { db } = require('../../db/energy_provider/index');
const UserModel = require('../../models/energy_provider/UserModel');
const JobModel = require('../../models/energy_provider/JobModel');
const { ApiError } = require('../../utils/energy_provider/apiError');

const state = { passed: 0, failed: 0 };

const check = (label, condition, extra) => {
  if (condition) {
    state.passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    state.failed += 1;
    console.log(`  FAIL  ${label}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
};

const expectError = async (label, fn, expectedStatus) => {
  try {
    await fn();
    check(label, false, 'expected an error but none was thrown');
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    check(label, status === expectedStatus, {
      message: err.message,
      status,
      expectedStatus,
    });
  }
};

const makeUser = async (overrides) => {
  const user = await UserModel.create({
    mobile: overrides.mobile,
    email: `${overrides.mobile}@example.com`,
    role: overrides.role,
    status: 'approved',
    fullName: overrides.fullName || 'Test Partner',
    businessName: overrides.businessName || 'Test Business',
  });

  if (overrides.online) {
    await UserModel.setOnline(user.id, true);
    // Return the refreshed row so the caller sees the current flags.
    return UserModel.findById(user.id);
  }

  return user;
};

const makeJob = async (overrides) =>
  JobModel.create({
    referenceId: overrides.referenceId,
    jobType: overrides.jobType || 'service',
    targetRole: overrides.targetRole,
    title: overrides.title || 'VFD repair',
    description: 'Test job',
    equipment: overrides.equipment || 'vfd',
    issueTags: overrides.issueTags || ['Overcurrent'],
    urgency: 'high',
    customerName: 'Ravi Kumar',
    customerCompany: 'Acme Industries',
    customerPhone: '9876543210',
    siteAddress: 'Plot 21, MIDC',
    siteArea: 'Pune',
    basePay: 1000,
    serviceCharge: overrides.serviceCharge || 800,
    status: 'open',
  });

const fullChecklist = [
  { id: 'work_completed', checked: true },
  { id: 'customer_satisfied', checked: true },
  { id: 'site_cleaned', checked: true },
];

module.exports = {
  db,
  state,
  check,
  expectError,
  makeUser,
  makeJob,
  fullChecklist,
};
