const crypto = require('crypto');
const { env } = require('../../config/energy_service/env');
const { hmacSha256, timingSafeEqualHex } = require('../../utils/energy_service/crypto');
const { pool } = require('../../config/energy_service/db');
const AppError = require('../../utils/energy_service/AppError');
const otpModel = require('../../models/energy_service/otp.model');
const smsService = require('./sms.service');
const emailService = require('./email.service');
const auditService = require('./audit.service');

function invalidOtp() {
  return new AppError('The verification code is invalid or has expired.', 400, 'INVALID_OTP');
}

function normalizePurpose(purpose) {
  if (purpose === 'password_reset') return 'forgot_password';
  return purpose || 'login';
}

// otp_code stores an HMAC, never the raw code, so a database copy cannot be reused.
function hashOtp(identifier, purpose, otp) {
  return hmacSha256(env.otpHashSecret, `${identifier}:${purpose}:${otp}`);
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendOtp({ identifier, channel, purpose, userId, req }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const latest = await otpModel.findLatest(identifier, normalizedPurpose);
  if (latest) {
    const retryAt = new Date(latest.created_at).getTime() + env.otpResendCooldownSeconds * 1000;
    if (retryAt > Date.now()) {
      const retryAfter = Math.ceil((retryAt - Date.now()) / 1000);
      throw new AppError(
        'Please wait before requesting another code.',
        429,
        'OTP_COOLDOWN',
        { retryAfterSeconds: Math.max(retryAfter, 1) },
      );
    }
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await otpModel.countRecentSends(identifier, normalizedPurpose, hourAgo);
  if (recent >= env.otpMaxSendsPerHour) {
    await auditService.createAuditLog({
      action: 'auth.otp_rate_limited',
      userId,
      description: 'OTP send rate limit reached',
      req,
      metadata: { purpose: normalizedPurpose },
    });
    throw new AppError('Too many verification codes were requested. Try again later.', 429, 'OTP_RATE_LIMITED');
  }

  const otp = generateOtp(identifier);
  const expiresAt = new Date(Date.now() + env.otpTtlSeconds * 1000);

  await otpModel.invalidateActive(identifier, normalizedPurpose);
  await otpModel.create({
    userId,
    identifier,
    otpCode: hashOtp(identifier, normalizedPurpose, otp),
    purpose: normalizedPurpose,
    expiresAt,
    maxAttempts: env.otpMaxAttempts,
  });

  if (channel === 'email') {
    await emailService.sendOtp({ to: identifier, otp });
  } else {
    await smsService.sendOtp({ phone: identifier, otp, purpose: normalizedPurpose });
  }
  await auditService.createAuditLog({
    action: 'auth.otp_sent',
    userId,
    description: 'OTP sent',
    req,
    metadata: { purpose: normalizedPurpose },
  });

  return {
    expiresIn: env.otpTtlSeconds,
    cooldownSeconds: env.otpResendCooldownSeconds,
  };
}

async function verifyOtp({ identifier, purpose, otp, req }) {
  const normalizedPurpose = normalizePurpose(purpose);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const record = await otpModel.findLatestForUpdate(identifier, normalizedPurpose, client);
    const expired = !record || new Date(record.expires_at).getTime() <= Date.now();
    const unusable = !record || record.status !== 'pending' || expired;
    if (unusable) {
      await client.query('COMMIT');
      await auditService.createAuditLog({
        action: 'auth.otp_failed',
        description: 'OTP rejected',
        req,
        metadata: { purpose: normalizedPurpose, reason: 'missing_or_expired' },
      });
      throw invalidOtp();
    }

    if (record.attempts >= record.max_attempts) {
      await client.query('COMMIT');
      await auditService.createAuditLog({
        action: 'auth.suspicious_otp_attempts',
        userId: record.user_id,
        description: 'OTP attempt limit reached',
        req,
        metadata: { purpose: normalizedPurpose, reason: 'attempt_limit' },
      });
      throw new AppError('Too many incorrect codes. Request a new code.', 429, 'OTP_ATTEMPT_LIMIT');
    }

    const matches = timingSafeEqualHex(record.otp_code, hashOtp(identifier, normalizedPurpose, otp));
    if (!matches) {
      const updated = await otpModel.incrementAttempts(record.id, client);
      await client.query('COMMIT');
      await auditService.createAuditLog({
        action: 'auth.otp_failed',
        userId: record.user_id,
        description: 'OTP rejected',
        req,
        metadata: { purpose: normalizedPurpose, reason: 'mismatch' },
      });
      if (updated && updated.attempts >= updated.max_attempts) {
        throw new AppError('Too many incorrect codes. Request a new code.', 429, 'OTP_ATTEMPT_LIMIT');
      }
      throw invalidOtp();
    }

    await otpModel.markVerified(record.id, client);
    await client.query('COMMIT');
    await auditService.createAuditLog({
      action: 'auth.otp_verified',
      userId: record.user_id,
      description: 'OTP verified',
      req,
      metadata: { purpose: normalizedPurpose },
    });
    return record;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Expected auth failures commit before throwing, so rollback can be a no-op.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  sendOtp,
  verifyOtp,
  hashOtp,
  normalizePurpose,
};
