const { publicUrl } = require('../../config/shared');

function toPublicUser(row, extras = {}) {
  if (!row) return null;
  const avatarUrl = row.avatar_url || null;
  return {
    id: row.id,
    name: row.name || null,
    fullName: row.name || null,
    phone: row.phone || null,
    secondaryPhone: row.secondary_phone || null,
    email: row.email || null,
    role: row.role,
    roleId: row.role_id,
    status: row.status || 'active',
    companyId: row.company_id || null,
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    avatarUrl: avatarUrl && !/^https?:\/\//i.test(avatarUrl) ? publicUrl(avatarUrl) : avatarUrl,
    onboardingStatus: extras.onboardingStatus || null,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { toPublicUser };
