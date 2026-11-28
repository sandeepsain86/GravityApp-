/**
 * HTTP smoke test.
 *
 * Boots the Express app against a throwaway SQLite database and exercises the
 * public routes end to end: OTP login, partner status, the job marketplace,
 * the five step workflow and the earnings summary.
 *
 * Run with:  node scripts/http.smoke.js
 */

/**
 * HTTP smoke test harness.
 *
 * The environment variables must be set before anything requires the config
 * or the database module, so this file owns the bootstrap and the test entry
 * point imports it first.
 */

process.env.DATABASE_URL = 'sqlite://./data/http_smoke.db';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '5099';
process.env.BASE_URL = `http://${process.env.HOST}:${process.env.PORT}`;

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const DB_FILE = path.join(BACKEND_ROOT, 'data', 'http_smoke.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

[DB_FILE, `${DB_FILE}-journal`].forEach((file) => {
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

const { db } = require('../../db/energy_provider/index');
const UserModel = require('../../models/energy_provider/UserModel');
const JobModel = require('../../models/energy_provider/JobModel');
const { app, server } = require('../../apps/energy_provider/index');

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

const BASE = `${process.env.BASE_URL}/api/v1`;

const request = async (method, url, { token, body } = {}) => {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = { raw: text };
  }
  return { status: response.status, body: json };
};

const seed = async () => {
  await UserModel.create({
    mobile: '9876543210',
    email: 'partner@example.com',
    role: 'service_partner',
    status: 'approved',
    fullName: 'Test Partner',
    businessName: 'Test Business',
  });
  await UserModel.create({
    mobile: '9000000015',
    email: 'admin@example.com',
    role: 'admin',
    status: 'approved',
    fullName: 'Test Administrator',
  });

  await JobModel.create({
    referenceId: 'EC-HTTP-0001',
    jobType: 'service',
    targetRole: 'service_partner',
    title: 'VFD not starting',
    equipment: 'vfd',
    issueTags: ['Overcurrent'],
    customerName: 'Ravi Kumar',
    customerPhone: '9876543210',
    basePay: 1000,
    serviceCharge: 800,
    status: 'open',
  });
};

module.exports = { state, check, request, seed, db, server };
