/**
 * Authentication & session service.
 *
 * Handles OTP issuance/verification, JWT issuance and the registration
 * bootstrap that happens the first time a mobile number is seen.
 */

const config = require('../../config/energy_provider/env');
const UserModel = require('../../models/energy_provider/UserModel');
const OtpModel = require('../../models/energy_provider/OtpModel');
const RegistrationModel = require('../../models/energy_provider/RegistrationModel');
const { AuditLogModel } = require('../../models/energy_provider/MarketplaceModels');
const { generateOtp } = require('../../utils/energy_provider/otp');
const { signAccessToken, signRefreshToken } = require('../../utils/energy_provider/jwt');
const { ApiError, isValidMobile } = require('../../utils/energy_provider/apiError');
const { db } = require('../../db/energy_provider/index');

const resolveRoleAccount = async (roleUser) => {
  if (!roleUser) return null;
  if (roleUser.status === 'approved') return roleUser;
  const root = roleUser.account_group_id || roleUser.id;
  const accounts = await db.query('SELECT * FROM `users` WHERE `account_group_id` = ? ORDER BY `id`', [root]);
  return accounts.find((account) => account.role === roleUser.role && account.status === 'approved') || roleUser;
};

const deliverOtp = async (mobile, otp) => {
  if (config.NODE_ENV !== 'production') return;

  let response;
  try {
    response = await fetch(config.SMS_PROVIDER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.SMS_PROVIDER_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: mobile,
        message: `Your Enrigy verification code is ${otp}. It expires in 10 minutes.`,
        senderId: config.SMS_SENDER_ID,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw ApiError.serviceUnavailable('OTP delivery is temporarily unavailable');
  }

  if (!response.ok) {
    throw ApiError.serviceUnavailable('OTP delivery provider rejected the request');
  }
};

const AuthService = {
  /**
   * Issue an OTP for a mobile number.
   * Enforces a resend cooldown so the endpoint cannot be abused.
   */
  async requestOtp({ mobile, purpose = 'login', email }) {
    if (!isValidMobile(mobile)) {
      throw ApiError.badRequest('Please enter a valid 10 digit mobile number');
    }
    if (!['login', 'registration'].includes(purpose)) {
      throw ApiError.badRequest('Invalid OTP purpose');
    }

    const existing = await OtpModel.findLatestForMobile(mobile);
    if (
      existing &&
      !existing.consumed_at &&
      Date.now() - new Date(existing.created_at).getTime() < config.OTP_RESEND_COOLDOWN_MS
    ) {
      const waitSeconds = Math.ceil(
        (config.OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(existing.created_at).getTime())) / 1000
      );
      throw ApiError.badRequest(`Please wait ${waitSeconds}s before requesting a new OTP`);
    }

    const otp = generateOtp();
    await deliverOtp(mobile, otp);
    const record = await OtpModel.create(mobile, {
      otp,
      ttlMs: config.OTP_TTL_MS,
      purpose,
      email: email || '',
    });

    return {
      mobile,
      purpose,
      otpSent: true,
      expiresAt: record.expires_at,
      // Returned only outside production so the flow can be tested.
      devOtp: config.NODE_ENV === 'production' ? undefined : otp,
    };
  },

  /**
   * Verify the OTP and issue access + refresh tokens.
   * A brand new mobile number gets a pending user plus a draft application so
   * the onboarding flow can continue.
   */
  async verifyOtp({ mobile, otp, purpose = 'login' }) {
    if (!mobile || !otp) {
      throw ApiError.badRequest('Mobile and OTP are required');
    }

    const record = await OtpModel.findLatestForMobile(mobile);
    if (!record) {
      throw ApiError.badRequest('No OTP requested for this number');
    }
    if (record.purpose !== purpose) {
      throw ApiError.badRequest('OTP was requested for a different purpose');
    }
    if (record.consumed_at) {
      throw ApiError.badRequest('OTP has already been used');
    }
    if (Date.now() > new Date(record.expires_at).getTime()) {
      throw ApiError.badRequest('OTP has expired');
    }
    if (record.attempts >= config.OTP_MAX_ATTEMPTS) {
      throw ApiError.badRequest('Too many incorrect attempts. Request a new OTP.');
    }
    if (record.code !== String(otp)) {
      await OtpModel.incrementAttempts(record.id);
      const remaining = config.OTP_MAX_ATTEMPTS - (record.attempts + 1);
      throw ApiError.badRequest(
        `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) left.` : ''}`.trim()
      );
    }

    await OtpModel.consume(record.id);

    let user = await UserModel.findByMobile(mobile);
    user = await resolveRoleAccount(user);
    let accountList = user ? await UserModel.findRoleAccounts(mobile) : [];
    let registrationId = null;
    let requiresRegistration = false;

    if (!user) {
      user = await UserModel.create({
        mobile,
        email: record.email || '',
        role: null,
        status: 'pending',
      });
    }

    const registrationList = await RegistrationModel.findByMobile(mobile);
    if (purpose === 'login' && accountList.length > 1) {
      return {
        roleSelectionToken: signRefreshToken({ userId: user.id, mobile: user.mobile, purpose: 'role-selection' }, config.JWT_SECRET, config.REFRESH_TOKEN_EXPIRES_IN),
        user: {
          id: user.id,
          mobile: user.mobile,
          email: user.email,
          role: user.role,
          status: user.status,
        },
        requiresRoleSelection: true,
        availableRoles: accountList.filter((account) => account.status === 'approved').map((account) => ({
          userId: account.id,
          role: account.role,
          status: account.status,
          registrationId: registrationList.find((reg) => String(reg.user_id) === String(account.id) && reg.partner_role === account.role)?.id || null,
        })),
      };
    }
    let application = registrationList.find((item) => String(item.user_id) === String(user.id) && item.partner_role === user.role && item.status !== 'draft')
      || await RegistrationModel.findUnsubmittedByMobile(mobile, user.role);
    if (!application) application = await RegistrationModel.findLatestByUser(user.id);
    if (!application && !user.role) {
      application = await RegistrationModel.create({
        userId: user.id,
        mobile,
        email: record.email || user.email || '',
        status: 'draft',
      });
    } else if (
      application
      && application.status === 'draft'
      && String(application.user_id || '') !== String(user.id)
      && !application.account_group_id
    ) {
      application = await RegistrationModel.updateById(application.id, {
        user_id: user.id,
        email: record.email || application.email || user.email || '',
      });
    }

    if (application) {
      registrationId = application.id;
      requiresRegistration = application.status === 'draft';
    }

    const accessToken = signAccessToken(
      { userId: user.id, mobile: user.mobile, role: user.role },
      config.JWT_SECRET,
      config.JWT_EXPIRES_IN
    );
    const refreshToken = signRefreshToken(
      { userId: user.id, mobile: user.mobile },
      config.JWT_SECRET,
      config.REFRESH_TOKEN_EXPIRES_IN
    );

    await AuditLogModel.create({
      actorId: user.id,
      entity: 'user',
      entityId: user.id,
      action: 'otp_verified',
      afterState: { purpose },
    });

    return {
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      registrationId,
      requiresRegistration,
    };
  },

  async getApprovedRoleAccount(mobile, role, rootUserId) {
    const root = await UserModel.findById(rootUserId);
    if (!root || root.mobile !== mobile) throw ApiError.unauthorized('Role selection account is invalid');
    const rootGroupId = root.account_group_id || root.id;
    const accounts = await db.query('SELECT * FROM `users` WHERE `account_group_id` = ? ORDER BY `id`', [rootGroupId]);
    const account = accounts.find((candidate) => candidate.role === role && candidate.status === 'approved')
      || ((root.role === role && root.status === 'approved') ? root : null);
    if (!account) throw ApiError.forbidden('This role does not have an approved account for this number');
    return account;
  },

  /** Load the authenticated user for a request. */
  async getUserById(userId) {
    const user = await UserModel.findById(userId);
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    return user;
  },
};

module.exports = AuthService;
