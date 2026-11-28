/**
 * One API, one database, four modules.
 *   /api/v1            energy_provider  (Energy Hub app)
 *   /api               energy_service   (Service Admin app)
 *   /api/website       energy_website
 *   /api/superadmin    superadmin
 *   /api/superadmin/console  Superadmin console UI API
 */
const express = require('express');
const cors = require('cors');

const { getBaseUrl } = require('./config/shared');
const { ensureUnifiedDatabase } = require('./config/database');
const { createSuperadminConsole } = require('./apps/superadmin/console');

function safeStartMessage(err) {
  const message = err && err.message ? err.message : 'Failed to start server';
  if (message.includes('://') || /password authentication/i.test(message)) {
    return 'Failed to start server. Check the database settings in .env.';
  }
  return message;
}

function isServiceApi(req) {
  return req.path.startsWith('/api/')
    && !req.path.startsWith('/api/v1')
    && !req.path.startsWith('/api/website')
    && !req.path.startsWith('/api/superadmin')
    && req.path !== '/api/health';
}

function isAttachmentUpload(req) {
  return req.method === 'POST' && /^\/api\/customer\/attachments\/?(?:\?|$)/.test(req.originalUrl || '');
}

async function start() {
  await ensureUnifiedDatabase();
  process.env.UNIFIED_SERVER = '1';

  const superadminConsole = createSuperadminConsole();
  await superadminConsole.initialize({
    email: process.env.SUPERADMIN_EMAIL?.trim() || '',
    name: process.env.SUPERADMIN_NAME?.trim() || 'Super Admin',
    password: process.env.SUPERADMIN_PASSWORD || '',
  });

  const hub = require('./apps/energy_provider/index');
  const { env } = require('./config/energy_service/env');
  const { connectDatabase } = require('./config/energy_service/db');
  const serviceRoutes = require('./routes/energy_service');
  const { apiLimiter } = require('./middleware/energy_service/rateLimit.middleware');
  const { requestId } = require('./middleware/energy_service/requestId.middleware');
  const { errorHandler: serviceErrorHandler } = require('./middleware/energy_service/error.middleware');
  const { errorHandler: providerErrorHandler } = require('./middleware/energy_provider/errorHandler');
  const passwordService = require('./services/energy_service/password.service');
  const { listMessages } = require('./services/energy_service/email.service');
  const smsService = require('./services/energy_service/sms.service');
  const { migrate } = require('../database/energy_service/migrate');

  await hub.prepareDatabase();
  await migrate();
  await connectDatabase();
  await passwordService.warmUp();

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use('/uploads', express.static(env.uploadsDir));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1')) {
      return express.urlencoded({ extended: true, limit: '10mb' })(req, res, () => {
        express.json({ limit: '10mb' })(req, res, next);
      });
    }
    if (isAttachmentUpload(req)) return next();
    if (req.path.startsWith('/api/profile/avatar')) {
      return express.json({ limit: '1mb' })(req, res, next);
    }
    if (req.path.startsWith('/api/website') || req.path.startsWith('/api/superadmin')) {
      return express.json({ limit: '1mb' })(req, res, next);
    }
    if (req.path.startsWith('/api')) {
      return express.json({ limit: '16kb' })(req, res, next);
    }
    return express.json({ limit: '1mb' })(req, res, next);
  });

  app.use((req, res, next) => {
    if (!isServiceApi(req)) return next();
    return apiLimiter(req, res, next);
  });

  app.use('/api/superadmin/console', superadminConsole.router);

  const port = env.port;

  app.get('/', async (_req, res) => {
    res.json({
      success: true,
      message: 'Energy Hub API is running',
      data: {
        database: env.database.database,
        modules: {
          energy_provider: '/api/v1',
          energy_service: '/api',
          energy_website: '/api/website',
          superadmin: '/api/superadmin',
          superadmin_console: '/api/superadmin/console',
        },
        sms: smsService.smsStatus(),
      },
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'energy_hub_backend',
      database: env.database.database,
      modules: ['energy_provider', 'energy_service', 'energy_website', 'superadmin', 'superadmin_console'],
      time: new Date().toISOString(),
    });
  });

  app.use('/api/v1/auth', require('./routes/energy_provider/auth'));
  app.use('/api/v1/registration', require('./routes/energy_provider/registration'));
  app.use('/api/v1/dashboard', require('./routes/energy_provider/dashboard'));
  app.use('/api/v1/jobs', require('./routes/energy_provider/jobs'));
  app.use('/api/v1/delivery', require('./routes/energy_provider/delivery'));
  app.use('/api/v1/marketplace', require('./routes/energy_provider/marketplace'));
  app.use('/api/v1/partner', require('./routes/energy_provider/partner'));
  app.use('/api/v1/admin', require('./routes/energy_provider/admin'));

  app.use('/api/website/contact', require('./routes/energy_website/contact.routes'));
  app.use('/api/website', require('./routes/energy_website/health.routes'));
  app.use('/api/superadmin/auth', require('./routes/superadmin/auth.routes'));
  app.use('/api/superadmin', require('./routes/superadmin/userManage.routes'));
  app.use('/api', serviceRoutes);

  if (env.devMailbox) {
    app.get('/api/dev/mailbox', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { messages: listMessages(), sms: smsService.listMessages() } });
    });
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api/v1')) {
      return res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.originalUrl} not found`,
      });
    }
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: req.requestId },
    });
  });

  app.use((err, req, res, next) => {
    if (req.path.startsWith('/api/v1')) return providerErrorHandler(err, req, res, next);
    if (req.path.startsWith('/api/website') || req.path.startsWith('/api/superadmin')) {
      return res.status(err.statusCode || err.status || 500).json({
        success: false,
        message: err.message || 'Internal server error',
      });
    }
    return serviceErrorHandler(err, req, res, next);
  });

  await new Promise((resolve, reject) => {
    const listener = app.listen(port, env.host, () => {
      console.log(`Energy Hub API running at ${getBaseUrl()}`);
      console.log(`One database: ${env.database.database}`);
      console.log('  energy_provider  /api/v1');
      console.log('  energy_service   /api');
      console.log('  energy_website   /api/website');
      console.log('  superadmin       /api/superadmin');
      console.log('  superadmin UI   /api/superadmin/console');
      resolve(listener);
    });
    listener.on('error', reject);
  });
}

start().catch((err) => {
  console.error(safeStartMessage(err));
  process.exit(1);
});
