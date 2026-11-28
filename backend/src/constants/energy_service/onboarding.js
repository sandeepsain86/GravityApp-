const pool = require('../../config/energy_service/db').pool;

const DEFAULT_STATUSES = {
  OTP_PENDING: 'OTP_PENDING',
  PHONE_VERIFIED: 'PHONE_VERIFIED',
  COMPANY_PENDING: 'COMPANY_PENDING',
  COMPANY_COMPLETED: 'COMPANY_COMPLETED',
  SITES_PENDING: 'SITES_PENDING',
  SITES_COMPLETED: 'SITES_COMPLETED',
  PROFILE_PENDING: 'PROFILE_PENDING',
  ONBOARDING_COMPLETED: 'ONBOARDING_COMPLETED',
};

let onboardingStatusCache = null;
let onboardingStatusCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadOnboardingStatuses() {
  const now = Date.now();
  if (onboardingStatusCache && now - onboardingStatusCacheTime < CACHE_TTL_MS) {
    return onboardingStatusCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT code FROM superadmin.onboarding_statuses ORDER BY sort_order ASC`
    );
    if (rows && rows.length > 0) {
      const statuses = {};
      for (const row of rows) {
        statuses[row.code] = row.code;
      }
      onboardingStatusCache = statuses;
      onboardingStatusCacheTime = now;
      return statuses;
    }
  } catch (error) {
    // Fall back to defaults if table not yet migrated
  }
  onboardingStatusCache = { ...DEFAULT_STATUSES };
  onboardingStatusCacheTime = now;
  return onboardingStatusCache;
}

function getStatusCode(key) {
  return DEFAULT_STATUSES[key] || key;
}

function hasProfile(user) {
  const name = user && (user.name || user.full_name);
  return Boolean(name && String(name).trim().length >= 2);
}

function hasVerifiedContact(user) {
  return Boolean(user && (
    user.phone_verified
    || user.phone_verified_at
    || user.email_verified
    || user.email_verified_at
  ));
}

async function deriveOnboardingStatus(user, siteCount = 0) {
  const statuses = await loadOnboardingStatuses();
  if (!user) return statuses.OTP_PENDING;
  if (!hasVerifiedContact(user) && !user.password_hash) return statuses.OTP_PENDING;
  if (!user.company_id) return statuses.COMPANY_PENDING;
  if (!siteCount) return statuses.SITES_PENDING;
  if (!hasProfile(user)) return statuses.PROFILE_PENDING;
  return statuses.ONBOARDING_COMPLETED;
}

async function onboardingFlags(user, siteCount = 0) {
  const statuses = await loadOnboardingStatuses();
  const status = await deriveOnboardingStatus(user, siteCount);
  return {
    status,
    phoneVerified: Boolean(user && (user.phone_verified || user.phone_verified_at)),
    emailVerified: Boolean(user && (user.email_verified || user.email_verified_at)),
    contactVerified: hasVerifiedContact(user),
    companyCompleted: Boolean(user && user.company_id),
    sitesCompleted: Number(siteCount) > 0,
    profileCompleted: hasProfile(user),
  };
}

module.exports = {
  DEFAULT_STATUSES,
  loadOnboardingStatuses,
  getStatusCode,
  deriveOnboardingStatus,
  onboardingFlags,
  hasProfile,
};
