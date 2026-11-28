const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { generateOtp } = require('../../../src/utils/energy_provider/otp');

const backendRoot = path.resolve(__dirname, '../../..');
const baseEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '3000',
  BASE_URL: 'https://api.example.test',
  CORS_ORIGIN: 'https://app.example.test',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_NAME: 'service_audit',
  DB_USER: 'audit',
  DB_PASSWORD: 'audit',
  DB_SSL: 'true',
  UPLOADS_DIR: './uploads/test',
  PRIVATE_UPLOADS_DIR: './private-uploads/test',
  ACCESS_TOKEN_SECRET: 'audit-access-token-secret-0123456789',
  OTP_HASH_SECRET: 'audit-otp-hash-secret-0123456789',
  SMTP_HOST: 'smtp.example.test',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'audit-twilio-auth-token',
  TWILIO_FROM_NUMBER: '+14155552671',
  ENABLE_DEV_MAILBOX: 'false',
};

function loadProductionConfig(overrides = {}) {
  return spawnSync(
    process.execPath,
    ['-e', "const { env } = require('./src/config/energy_service/env'); console.log(env.smsProvider);"],
    {
      cwd: backendRoot,
      env: { ...baseEnvironment, ...overrides },
      encoding: 'utf8',
    },
  );
}

test('Energy Provider OTPs do not honor fixed-code settings', () => {
  const otp = generateOtp('9876543210', {
    FIXED_MOBILE: '9876543210',
    FIXED_OTP: '000000',
  });

  assert.match(otp, /^[1-9]\d{5}$/);
  assert.notEqual(otp, '000000');
});

test('shared runtime uses one BASE_URL and DB_* plus configured upload roots', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', `
      const shared = require('./src/config/shared');
      console.log(JSON.stringify({
        baseUrl: shared.getBaseUrl(),
        apiUrl: shared.publicUrl('/api/v1'),
        database: shared.getDatabaseConfig().database,
        uploads: shared.getPublicUploadsDir(),
        privateUploads: shared.getPrivateUploadsDir(),
      }));
    `],
    {
      cwd: backendRoot,
      env: {
        ...baseEnvironment,
        BASE_URL: 'https://api.example.test',
        DB_NAME: 'configured_db',
        UPLOADS_DIR: './var/public-files',
        PRIVATE_UPLOADS_DIR: './var/private-files',
        DATABASE_URL: 'this-is-not-used',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    baseUrl: 'https://api.example.test',
    apiUrl: 'https://api.example.test/api/v1',
    database: 'configured_db',
    uploads: path.resolve(backendRoot, 'var/public-files'),
    privateUploads: path.resolve(backendRoot, 'var/private-files'),
  });
});

test('database TLS verifies certificates, accepts a configured CA, and rejects production without TLS', () => {
  const loadDatabaseConfig = (overrides = {}) => spawnSync(
    process.execPath,
    ['-e', "const config = require('./src/config/shared').getDatabaseConfig(); console.log(JSON.stringify(config.ssl ?? null));"],
    {
      cwd: backendRoot,
      env: { ...baseEnvironment, ...overrides },
      encoding: 'utf8',
    },
  );
  const verified = loadDatabaseConfig({ DB_SSL: 'true', DB_SSL_CA: '' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), { rejectUnauthorized: true });

  const caPem = '-----BEGIN CERTIFICATE-----\\nAQID\\n-----END CERTIFICATE-----';
  const configuredCa = loadDatabaseConfig({ DB_SSL: 'true', DB_SSL_CA: caPem });
  assert.equal(configuredCa.status, 0, configuredCa.stderr);
  assert.deepEqual(JSON.parse(configuredCa.stdout), {
    rejectUnauthorized: true,
    ca: caPem.replace(/\\n/g, '\n'),
  });

  const noTls = loadDatabaseConfig({ DB_SSL: 'false' });
  assert.notEqual(noTls.status, 0);
  assert.match(noTls.stderr, /DB_SSL=true is required in production/);
  const localNoTls = loadDatabaseConfig({ NODE_ENV: 'development', DB_SSL: 'false' });
  assert.equal(localNoTls.status, 0, localNoTls.stderr);
  assert.equal(JSON.parse(localNoTls.stdout), null);
});

test('production configuration rejects a missing SMS provider', () => {
  const result = loadProductionConfig({ SMS_PROVIDER: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SMS_PROVIDER=twilio is required in production/);
});

test('production configuration rejects a missing or reused OTP hash secret', () => {
  const missing = loadProductionConfig({ OTP_HASH_SECRET: '' });
  const reused = loadProductionConfig({
    OTP_HASH_SECRET: baseEnvironment.ACCESS_TOKEN_SECRET,
  });

  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /OTP_HASH_SECRET must be unique and set in production/);
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /OTP_HASH_SECRET must be unique and set in production/);
});

test('production configuration accepts a configured Twilio provider', () => {
  const result = loadProductionConfig({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'audit-twilio-auth-token',
    TWILIO_FROM_NUMBER: '+14155552671',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /twilio/);
});
