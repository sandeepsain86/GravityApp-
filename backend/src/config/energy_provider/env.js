const shared = require('../shared');
const NODE_ENV = process.env.NODE_ENV || 'development';
const testDatabaseUrl = NODE_ENV === 'test' ? process.env.DATABASE_URL || '' : '';
const database = testDatabaseUrl ? null : shared.getDatabaseConfig();
const PORT = Number(process.env.PORT);
const HOST = (process.env.HOST || '').trim();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
if (!HOST) {
  throw new Error('Missing required environment variable: HOST');
}

/**
 * Central runtime configuration.
 *
 * Every credential / connection detail is read from the environment so nothing
 * sensitive is hard-coded.  See `.env.example` for the full list of supported
 * variables.
 */
module.exports = {
  PORT,
  HOST,
  NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  OTP_TTL_MS: parseInt(process.env.OTP_TTL_MS, 10) || 10 * 60 * 1000,
  OTP_MAX_ATTEMPTS: parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5,
  OTP_RESEND_COOLDOWN_MS:
    parseInt(process.env.OTP_RESEND_COOLDOWN_MS, 10) || 30 * 1000,
  SMS_PROVIDER_URL: process.env.SMS_PROVIDER_URL || '',
  SMS_PROVIDER_TOKEN: process.env.SMS_PROVIDER_TOKEN || '',
  SMS_SENDER_ID: process.env.SMS_SENDER_ID || '',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',

  // ------------------------------------------------------------------
  // Database
  // ------------------------------------------------------------------
  // DATABASE_URL is retained only for isolated SQLite smoke tests.
  DATABASE_URL: testDatabaseUrl,
  DB_HOST: database ? database.host : '',
  DB_PORT: database ? database.port : 0,
  DB_USER: database ? database.user : '',
  DB_PASSWORD: database ? database.password : '',
  DB_NAME: database ? database.database : '',
  DB_SSL: database ? !!database.ssl : false,
  DB_SSL_OPTIONS: database ? database.ssl : undefined,
};
