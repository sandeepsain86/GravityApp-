const {
  getDatabaseConfig,
  getPublicUploadsDir,
} = require('../shared');

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const accessTokenSecret = required('ACCESS_TOKEN_SECRET');
const placeholderSecret = 'replace-with-at-least-32-random-characters';

if (accessTokenSecret.length < 32 || accessTokenSecret === placeholderSecret) {
  throw new Error('ACCESS_TOKEN_SECRET must be a unique random string of at least 32 characters.');
}

const devMailbox = boolEnv('ENABLE_DEV_MAILBOX', false);
if (nodeEnv === 'production' && devMailbox) {
  throw new Error('ENABLE_DEV_MAILBOX cannot be enabled in production.');
}

const smtpHost = (process.env.SMTP_HOST || '').trim();
if (nodeEnv === 'production' && !smtpHost) {
  throw new Error('SMTP_HOST is required in production.');
}

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const smsProvider = (process.env.SMS_PROVIDER || (nodeEnv === 'production' ? '' : 'dev')).trim();
if (nodeEnv === 'production' && smsProvider !== 'twilio') {
  throw new Error('SMS_PROVIDER=twilio is required in production.');
}
if (!['', 'dev', 'twilio'].includes(smsProvider)) {
  throw new Error('SMS_PROVIDER must be dev or twilio.');
}

const configuredOtpHashSecret = (process.env.OTP_HASH_SECRET || '').trim();
const otpHashSecret = configuredOtpHashSecret || accessTokenSecret;
if (otpHashSecret.length < 32) {
  throw new Error('OTP_HASH_SECRET must be at least 32 characters when set.');
}
if (nodeEnv === 'production'
  && (!configuredOtpHashSecret || configuredOtpHashSecret === accessTokenSecret)) {
  throw new Error('OTP_HASH_SECRET must be unique and set in production.');
}

const env = {
  nodeEnv,
  port: intEnv('PORT', Number(required('PORT')), 1, 65535),
  host: required('HOST'),
  corsOrigin: required('CORS_ORIGIN'),
  database: getDatabaseConfig(),
  uploadsDir: getPublicUploadsDir(),
  accessTokenSecret,
  accessTokenTtlSeconds: intEnv('ACCESS_TOKEN_TTL_SECONDS', 900, 60, 1800),
  refreshTokenTtlDays: intEnv('REFRESH_TOKEN_TTL_DAYS', 7, 1, 30),
  jwtIssuer: 'service-admin-api',
  jwtAudience: 'service-admin-app',
  corsOrigins,
  trustProxy: boolEnv('TRUST_PROXY', false),
  authRateLimitWindowMs: intEnv('AUTH_RATE_LIMIT_WINDOW_MS', 900000, 1000, 86400000),
  authRateLimitMax: intEnv('AUTH_RATE_LIMIT_MAX', 10, 1, 1000),
  refreshRateLimitMax: intEnv('REFRESH_RATE_LIMIT_MAX', 30, 1, 5000),
  apiRateLimitWindowMs: intEnv('API_RATE_LIMIT_WINDOW_MS', 900000, 1000, 86400000),
  apiRateLimitMax: intEnv('API_RATE_LIMIT_MAX', 300, 1, 10000),
  otpRateLimitMax: intEnv('OTP_RATE_LIMIT_MAX', 5, 1, 100),
  lockoutMaxAttempts: intEnv('LOCKOUT_MAX_ATTEMPTS', 5, 3, 20),
  lockoutMinutes: intEnv('LOCKOUT_MINUTES', 15, 1, 1440),
  otpTtlSeconds: intEnv('OTP_TTL_SECONDS', 300, 60, 900),
  otpResendCooldownSeconds: intEnv('OTP_RESEND_COOLDOWN_SECONDS', 60, 0, 600),
  otpMaxAttempts: intEnv('OTP_MAX_ATTEMPTS', 5, 3, 10),
  otpMaxSendsPerHour: intEnv('OTP_MAX_SENDS_PER_HOUR', 5, 1, 20),
  otpHashSecret,
  smsProvider,
  twilio: {
    accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: (process.env.TWILIO_FROM_NUMBER || '').trim(),
    messagingServiceSid: (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim(),
  },
  twilioEnabled: false,
  devMailbox,
  emailVerificationTtlHours: 24,
  passwordResetTtlMinutes: 30,
  smtp: {
    host: smtpHost,
    port: intEnv('SMTP_PORT', 587, 1, 65535),
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: (process.env.SMTP_FROM || 'noreply@example.com').trim(),
  },
};

if (env.smsProvider === 'twilio') {
  const sidOk = /^AC[0-9a-fA-F]{32}$/.test(env.twilio.accountSid);
  const senderOk = /^\+[1-9]\d{7,14}$/.test(env.twilio.fromNumber)
    || /^MG[0-9a-fA-F]{32}$/.test(env.twilio.messagingServiceSid);
  if (!sidOk || !env.twilio.authToken || env.twilio.authToken.length < 16 || !senderOk) {
    throw new Error(
      'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID (AC...), TWILIO_AUTH_TOKEN, '
      + 'and TWILIO_FROM_NUMBER (E.164) or TWILIO_MESSAGING_SERVICE_SID (MG...).',
    );
  }
  env.twilioEnabled = true;
}

module.exports = { env };
