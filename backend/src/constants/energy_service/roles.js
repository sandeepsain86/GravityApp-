const pool = require('../../config/energy_service/db').pool;

const DEFAULT_ROLES = {
  OWNER: 'DIRECTOR_OWNER',
  ADMIN: 'MAINTENANCE_HEAD',
  MANAGER: 'PURCHASE_MGR',
  USER: 'SITE_ENGINEER',
};

const DEFAULT_ROLE_NAMES = [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER, DEFAULT_ROLES.USER];

const DEFAULT_ALL_ROLES = DEFAULT_ROLE_NAMES;

const DEFAULT_ACCESS = {
  'companies.create': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.USER],
  'companies.read': DEFAULT_ALL_ROLES,
  'companies.update': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'companies.status': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'sites.create': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'sites.read': DEFAULT_ALL_ROLES,
  'sites.update': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'sites.delete': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'sites.status': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'profile.read': DEFAULT_ALL_ROLES,
  'profile.update': DEFAULT_ALL_ROLES,
  'notifications.read': DEFAULT_ALL_ROLES,
  'sessions.read': DEFAULT_ALL_ROLES,
  'sessions.revoke': DEFAULT_ALL_ROLES,
  'api_keys.create': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'api_keys.read': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'api_keys.revoke': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'api_keys.rotate': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'users.read': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'users.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'roles.read': DEFAULT_ALL_ROLES,
  'roles.manage': [DEFAULT_ROLES.OWNER],
  'dashboard.read': DEFAULT_ALL_ROLES,
  'jobs.read': DEFAULT_ALL_ROLES,
  'jobs.create': DEFAULT_ALL_ROLES,
  'jobs.update': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.USER],
  'amc.read': DEFAULT_ALL_ROLES,
  'amc.quote': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'signals.create': DEFAULT_ALL_ROLES,
  'repairs.create': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'marketplace.read': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'marketplace.write': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN, DEFAULT_ROLES.MANAGER],
  'marketplace.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'certs.read': DEFAULT_ALL_ROLES,
  'certs.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'customer.amc.read': DEFAULT_ALL_ROLES,
  'customer.amc.write': DEFAULT_ALL_ROLES,
  'customer.amc.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'customer.repairs.read': DEFAULT_ALL_ROLES,
  'customer.repairs.write': DEFAULT_ALL_ROLES,
  'customer.repairs.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'customer.projects.read': DEFAULT_ALL_ROLES,
  'customer.projects.write': DEFAULT_ALL_ROLES,
  'customer.projects.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
  'customer.services.read': DEFAULT_ALL_ROLES,
  'customer.services.write': DEFAULT_ALL_ROLES,
  'customer.services.manage': [DEFAULT_ROLES.OWNER, DEFAULT_ROLES.ADMIN],
};

let rolesCache = null;
let rolesCacheTime = 0;
let accessCache = null;
let accessCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadRolesFromDb() {
  const now = Date.now();
  if (rolesCache && now - rolesCacheTime < CACHE_TTL_MS) {
    return { roles: rolesCache, access: accessCache };
  }
  try {
    const { rows } = await pool.query(
      `SELECT name FROM public.roles ORDER BY name`
    );
    if (rows && rows.length > 0) {
      const roles = {};
      const roleNames = [];
      for (const row of rows) {
        const upperName = row.name.toUpperCase();
        roles[upperName] = row.name;
        roleNames.push(row.name);
      }
      rolesCache = roles;
      rolesCacheTime = now;
      accessCache = buildAccessFromRoles(roles, roleNames);
      accessCacheTime = now;
      return { roles: rolesCache, access: accessCache };
    }
  } catch (error) {
    // Fall back to defaults
  }
  rolesCache = { ...DEFAULT_ROLES };
  rolesCacheTime = now;
  accessCache = { ...DEFAULT_ACCESS };
  accessCacheTime = now;
  return { roles: rolesCache, access: accessCache };
}

function buildAccessFromRoles(roles, roleNames) {
  const allRoles = roleNames;
  const OWNER = roles.OWNER || DEFAULT_ROLES.OWNER;
  const ADMIN = roles.ADMIN || DEFAULT_ROLES.ADMIN;
  const MANAGER = roles.MANAGER || DEFAULT_ROLES.MANAGER;
  const USER = roles.USER || DEFAULT_ROLES.USER;
  return {
    'companies.create': [OWNER, ADMIN, USER],
    'companies.read': allRoles,
    'companies.update': [OWNER, ADMIN],
    'companies.status': [OWNER, ADMIN],
    'sites.create': [OWNER, ADMIN, MANAGER],
    'sites.read': allRoles,
    'sites.update': [OWNER, ADMIN, MANAGER],
    'sites.delete': [OWNER, ADMIN],
    'sites.status': [OWNER, ADMIN, MANAGER],
    'profile.read': allRoles,
    'profile.update': allRoles,
    'notifications.read': allRoles,
    'sessions.read': allRoles,
    'sessions.revoke': allRoles,
    'api_keys.create': [OWNER, ADMIN],
    'api_keys.read': [OWNER, ADMIN],
    'api_keys.revoke': [OWNER, ADMIN],
    'api_keys.rotate': [OWNER, ADMIN],
    'users.read': [OWNER, ADMIN, MANAGER],
    'users.manage': [OWNER, ADMIN],
    'roles.read': allRoles,
    'roles.manage': [OWNER],
    'dashboard.read': allRoles,
    'jobs.read': allRoles,
    'jobs.create': allRoles,
    'jobs.update': [OWNER, ADMIN, USER],
    'amc.read': allRoles,
    'amc.quote': [OWNER, ADMIN, MANAGER],
    'signals.create': allRoles,
    'repairs.create': [OWNER, ADMIN, MANAGER],
    'marketplace.read': [OWNER, ADMIN, MANAGER],
    'marketplace.write': [OWNER, ADMIN, MANAGER],
    'marketplace.manage': [OWNER, ADMIN],
    'certs.read': allRoles,
    'certs.manage': [OWNER, ADMIN],
    'customer.amc.read': allRoles,
    'customer.amc.write': allRoles,
    'customer.amc.manage': [OWNER, ADMIN],
    'customer.repairs.read': allRoles,
    'customer.repairs.write': allRoles,
    'customer.repairs.manage': [OWNER, ADMIN],
    'customer.projects.read': allRoles,
    'customer.projects.write': allRoles,
    'customer.projects.manage': [OWNER, ADMIN],
    'customer.services.read': allRoles,
    'customer.services.write': allRoles,
    'customer.services.manage': [OWNER, ADMIN],
  };
}

function roleAllows(role, action) {
  const access = accessCache || DEFAULT_ACCESS;
  const allowed = access[action];
  return Array.isArray(allowed) && allowed.includes(role);
}

module.exports = {
  DEFAULT_ROLES,
  DEFAULT_ROLE_NAMES,
  DEFAULT_ALL_ROLES,
  DEFAULT_ACCESS,
  loadRolesFromDb,
  buildAccessFromRoles,
  roleAllows,
  get ROLES() { return rolesCache || DEFAULT_ROLES; },
  get ROLE_NAMES() { return rolesCache ? Object.values(rolesCache) : DEFAULT_ROLE_NAMES; },
  get ALL_ROLES() { return rolesCache ? Object.values(rolesCache) : DEFAULT_ALL_ROLES; },
  get ACCESS() { return accessCache || DEFAULT_ACCESS; },
};
