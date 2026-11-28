const fs = require('fs');
const path = require('path');
const AppError = require('../../utils/energy_service/AppError');
const { ONBOARDING, deriveOnboardingStatus, onboardingFlags } = require('../../constants/energy_service/onboarding');
const { toPublicUser } = require('../../utils/energy_service/publicUser');
const userModel = require('../../models/energy_service/user.model');
const roleModel = require('../../models/energy_service/role.model');
const siteModel = require('../../models/energy_service/site.model');
const companyModel = require('../../models/energy_service/company.model');
const { toPublicCompany } = require('./company.service');
const auditService = require('./audit.service');
const { withTransaction } = require('../../utils/energy_service/transaction');
const rbacService = require('./rbac.service');
const { getPublicUploadsDir } = require('../../config/shared');

const AVATAR_DIR = path.join(getPublicUploadsDir(), 'avatars');
const AVATAR_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function parseAvatar(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new AppError('Use a JPEG, PNG, or WebP photo.', 422, 'INVALID_AVATAR');
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length < 64) {
    throw new AppError('That photo could not be read.', 422, 'INVALID_AVATAR');
  }
  if (buffer.length > 700 * 1024) {
    throw new AppError('Photo must be under 700 KB.', 422, 'AVATAR_TOO_LARGE');
  }
  return { ext: AVATAR_TYPES[match[1].toLowerCase()], buffer };
}

async function loadProfile(userId) {
  const user = await userModel.findById(userId);
  if (!user) throw new AppError('Unauthorized.', 401, 'UNAUTHORIZED');
  const siteCount = user.company_id ? await siteModel.countByCompany(user.company_id) : 0;
  const onboardingStatus = deriveOnboardingStatus(user, siteCount);
  const company = user.company_id ? await companyModel.findById(user.company_id) : null;
  return {
    user: toPublicUser(user, { onboardingStatus }),
    onboardingStatus,
    onboarding: onboardingFlags(user, siteCount),
    company: company ? toPublicCompany(company) : null,
  };
}

async function upsertProfile(userId, input, req) {
  const existing = await userModel.findById(userId);
  if (!existing) throw new AppError('Unauthorized.', 401, 'UNAUTHORIZED');
  if (input.email) {
    const taken = await userModel.findByEmail(input.email);
    if (taken && taken.id !== userId) {
      throw new AppError('An account with this email already exists.', 409, 'EMAIL_IN_USE');
    }
  }

  let requestedRole;
  if (input.role && input.role !== existing.role) {
    requestedRole = await roleModel.findByName(input.role);
    if (!requestedRole || requestedRole.status !== 'active') {
      throw new AppError('The selected role is not available.', 422, 'INVALID_ROLE');
    }
    if (!rbacService.canSelfAssignRole(existing.role, requestedRole.name)) {
      throw new AppError('You cannot assign yourself a role with additional permissions.', 403, 'SELF_ROLE_ESCALATION');
    }
  }

  const user = await withTransaction(async (client) => {
    const updated = await userModel.updateProfile(userId, {
      name: input.fullName || input.name,
      email: input.email,
      secondaryPhone: input.secondaryPhone,
    }, client);
    if (requestedRole) {
      await userModel.setRole(userId, requestedRole.id, client);
      return userModel.findById(userId, client);
    }
    return updated;
  });
  const siteCount = user.company_id ? await siteModel.countByCompany(user.company_id) : 0;
  const onboardingStatus = deriveOnboardingStatus(user, siteCount);
  await auditService.createAuditLog({
    userId,
    companyId: user.company_id,
    action: 'user.updated',
    entityType: 'user',
    entityId: userId,
    description: 'Profile updated',
    metadata: requestedRole ? { role: requestedRole.name } : undefined,
    req,
  });
  return {
    user: toPublicUser(user, { onboardingStatus }),
    onboardingStatus,
    onboarding: onboardingFlags(user, siteCount),
    message: onboardingStatus === ONBOARDING.ONBOARDING_COMPLETED
      ? 'Profile saved. Onboarding is complete.'
      : 'Profile saved.',
  };
}

async function setAvatar(userId, image, req) {
  const existing = await userModel.findById(userId);
  if (!existing) throw new AppError('Unauthorized.', 401, 'UNAUTHORIZED');
  const { ext, buffer } = parseAvatar(image);
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const fileName = `${userId}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, fileName), buffer);
  const avatarUrl = `/uploads/avatars/${fileName}?v=${Date.now()}`;
  const user = await userModel.updateProfile(userId, { avatarUrl });
  await auditService.createAuditLog({
    userId,
    companyId: user.company_id,
    action: 'user.updated',
    entityType: 'user',
    entityId: userId,
    description: 'Profile photo updated',
    req,
  });
  const siteCount = user.company_id ? await siteModel.countByCompany(user.company_id) : 0;
  const onboardingStatus = deriveOnboardingStatus(user, siteCount);
  return {
    user: toPublicUser(user, { onboardingStatus }),
    onboardingStatus,
    message: 'Profile photo saved.',
  };
}

module.exports = {
  loadProfile,
  upsertProfile,
  setAvatar,
};
