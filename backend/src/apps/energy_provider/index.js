require('../../config/shared');
const express = require('express');
const cors = require('cors');
const config = require('../../config/energy_provider/env');
const { getBaseUrl } = require('../../config/shared');
const { notFound, errorHandler } = require('../../middleware/energy_provider/errorHandler');
const { db } = require('../../db/energy_provider/index');

const app = express();

const validateProductionConfiguration = () => {
  if (config.NODE_ENV !== 'production') return;

  const problems = [];
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must contain at least 32 characters');
  }
  if (config.CORS_ORIGIN === '*') {
    problems.push('CORS_ORIGIN must be restricted to the production app origins');
  }
  if (!config.DB_HOST || !config.DB_PORT || !config.DB_NAME || !config.DB_USER || !config.DB_PASSWORD) {
    problems.push('DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD are required');
  }
  if (!config.DB_SSL) {
    problems.push('DB_SSL must be enabled for production database connections');
  }
  if (!config.SMS_PROVIDER_URL || !config.SMS_PROVIDER_TOKEN) {
    problems.push('SMS_PROVIDER_URL and SMS_PROVIDER_TOKEN are required for OTP delivery');
  }

  if (problems.length) {
    throw new Error(`Production readiness checks failed: ${problems.join('; ')}`);
  }
};

// CORS configuration - allows mobile emulator/device access
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'energy_hub_backend',
    app: 'energy_provider',
    time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// API v1 routes
app.use('/api/v1/auth', require('../../routes/energy_provider/auth'));
app.use('/api/v1/registration', require('../../routes/energy_provider/registration'));
app.use('/api/v1/dashboard', require('../../routes/energy_provider/dashboard'));
app.use('/api/v1/jobs', require('../../routes/energy_provider/jobs'));
app.use('/api/v1/delivery', require('../../routes/energy_provider/delivery'));
app.use('/api/v1/marketplace', require('../../routes/energy_provider/marketplace'));
app.use('/api/v1/partner', require('../../routes/energy_provider/partner'));
app.use('/api/v1/admin', require('../../routes/energy_provider/admin'));

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

/**
 * Start the API server.
 *
 * The database schema is created on boot so the API works on a fresh machine.
 * The returned promise resolves with the listening server, which lets the
 * test harness shut it down again.
 */
const prepareDatabase = async () => {
  validateProductionConfiguration();
  await db.init();
  console.log(`Database ready (${db.describe()})`);
};

const start = async () => {
  try {
    await prepareDatabase();
  } catch (err) {
    console.error('Database initialisation failed:', err.message);
    throw err;
  }

  const server = await new Promise((resolve) => {
    const listener = app.listen(config.PORT, config.HOST, () => {
      console.log(`Energy Hub Backend running at ${getBaseUrl()}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`JWT Secret configured: ${!!config.JWT_SECRET}`);
      console.log(`CORS Origin: ${config.CORS_ORIGIN}`);
      resolve(listener);
    });
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  return server;
};

const serverPromise = process.env.UNIFIED_SERVER ? null : start();

module.exports = {
  app,
  server: serverPromise,
  start,
  prepareDatabase,
  validateProductionConfiguration,
};
