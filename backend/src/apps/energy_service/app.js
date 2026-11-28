const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { publicUrl } = require('../../config/shared');
const { env } = require('../../config/energy_service/env');
const { pool } = require('../../config/energy_service/db');
const routes = require('../../routes/energy_service/index');
const { apiLimiter } = require('../../middleware/energy_service/rateLimit.middleware');
const { requestId } = require('../../middleware/energy_service/requestId.middleware');
const { notFoundHandler, errorHandler } = require('../../middleware/energy_service/error.middleware');
const { listMessages } = require('../../services/energy_service/email.service');
const smsService = require('../../services/energy_service/sms.service');

const jsonSmall = express.json({ limit: '16kb' });
const jsonAvatar = express.json({ limit: '1mb' });

function isAttachmentUpload(req) {
  return req.method === 'POST'
    && /^\/api\/customer\/attachments\/?(?:\?|$)/.test(req.url || '');
}

function createApp() {
  const app = express();
  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(requestId);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    maxAge: 600,
  }));
  app.use((req, res, next) => {
    if (!isAttachmentUpload(req)) return next();
    return apiLimiter(req, res, (error) => {
      if (error) return next(error);
      req.attachmentUploadRateLimited = true;
      return next();
    });
  });
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.url && req.url.startsWith('/api/profile/avatar')) {
      return jsonAvatar(req, res, next);
    }
    if (isAttachmentUpload(req)) return next();
    return jsonSmall(req, res, next);
  });
  app.use('/uploads', express.static(env.uploadsDir));
  app.use((req, res, next) => {
    if (req.attachmentUploadRateLimited) return next();
    return apiLimiter(req, res, next);
  });

  app.get('/', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      return res.json({
        success: true,
        message: 'Service Admin Backend and database are running',
        data: {
          sms: smsService.smsStatus(),
          hubApi: publicUrl('/api/v1'),
        },
      });
    } catch (error) {
      console.error('Database health check failed:', error.code || error.name || 'unknown');
      return res.status(503).json({
        success: false,
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'The database is temporarily unavailable.',
        },
      });
    }
  });

  app.use('/api', routes);

  if (env.devMailbox) {
    app.get('/api/dev/mailbox', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: {
          messages: listMessages(),
          sms: smsService.listMessages(),
        },
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
