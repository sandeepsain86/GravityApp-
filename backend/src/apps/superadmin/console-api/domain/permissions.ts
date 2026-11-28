import { pool } from '../../../../config/energy_service/db.js';

export const DEFAULT_ROLES = ['superadmin', 'admin', 'viewer'] as const;
export type Role = (typeof DEFAULT_ROLES)[number];

export const DEFAULT_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type PermissionAction = (typeof DEFAULT_ACTIONS)[number];

export const DEFAULT_PAGES = [
  { key: 'dashboard', label: 'Dashboard', group: 'Overview' },
  { key: 'analytics', label: 'Analytics', group: 'Overview' },
  { key: 'livemonitor', label: 'Live Monitor', group: 'Operations' },
  { key: 'jobs', label: 'Jobs', group: 'Operations' },
  { key: 'repair', label: 'Repair Center', group: 'Operations' },
  { key: 'projects', label: 'Projects', group: 'Operations' },
  { key: 'inventory', label: 'Inventory', group: 'Operations' },
  { key: 'verification', label: 'Verification', group: 'Field Partners' },
  { key: 'disputes', label: 'Disputes', group: 'Field Partners' },
  { key: 'directory', label: 'App Registrations', group: 'Field Partners' },
  { key: 'companies', label: 'Companies', group: 'Business' },
  { key: 'amc', label: 'AMC Contracts', group: 'Business' },
  { key: 'finance', label: 'Finance & Payouts', group: 'Business' },
  { key: 'invoices', label: 'Invoices', group: 'Business' },
  { key: 'customer-panel', label: 'Customer Panel', group: 'Apps & Admin' },
  { key: 'partner-app', label: 'Partner App', group: 'Apps & Admin' },
  { key: 'users', label: 'Users & Roles', group: 'Apps & Admin' },
  { key: 'activity', label: 'Activity Log', group: 'Apps & Admin' },
  { key: 'settings', label: 'Settings', group: 'Apps & Admin' },
] as const;

export type PageKey = (typeof DEFAULT_PAGES)[number]['key'];
export type PagePermissions = Record<PermissionAction, boolean>;
export type RolePermissions = Record<PageKey, PagePermissions>;
export type PermissionMatrix = Record<Role, RolePermissions>;

let pagesCache: typeof DEFAULT_PAGES | null = null;
let pagesCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadPagesFromDb(): Promise<typeof DEFAULT_PAGES> {
  const now = Date.now();
  if (pagesCache && now - pagesCacheTime < CACHE_TTL_MS) {
    return pagesCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT key, label, group_name AS group FROM superadmin.pages WHERE is_active = TRUE ORDER BY sort_order ASC`
    );
    if (rows && rows.length > 0) {
      const pages = rows.map((row: any) => ({
        key: row.key,
        label: row.label,
        group: row.group,
      }));
      pagesCache = pages as typeof DEFAULT_PAGES;
      pagesCacheTime = now;
      return pagesCache;
    }
  } catch (error) {
    // Fall back to defaults
  }
  pagesCache = [...DEFAULT_PAGES] as typeof DEFAULT_PAGES;
  pagesCacheTime = now;
  return pagesCache;
}

const EMPTY_ACTIONS: PagePermissions = {
  view: false,
  create: false,
  edit: false,
  delete: false,
};

function buildRolePermissions(
  enabledPages: readonly PageKey[],
  allowedActions: readonly PermissionAction[],
  pages: typeof DEFAULT_PAGES = DEFAULT_PAGES,
  actions: readonly PermissionAction[] = DEFAULT_ACTIONS,
): RolePermissions {
  return Object.fromEntries(
    pages.map(({ key }) => [
      key,
      enabledPages.includes(key as PageKey)
        ? Object.fromEntries(actions.map((action) => [action, actions.includes(action)]))
        : { ...EMPTY_ACTIONS },
    ]),
  ) as RolePermissions;
}

export async function createDefaultPermissionMatrix(): Promise<PermissionMatrix> {
  const pages = await loadPagesFromDb();
  const allPages = pages.map(({ key }) => key as PageKey);
  const allActions = [...DEFAULT_ACTIONS];
  const adminPages = allPages.filter((key) => !['users', 'activity'].includes(key));
  const viewerPages = allPages.filter((key) =>
    !['users', 'activity', 'settings', 'directory'].includes(key),
  );

  return {
    superadmin: buildRolePermissions(allPages, allActions, pages),
    admin: buildRolePermissions(adminPages, ['view', 'create', 'edit', 'delete'], pages),
    viewer: buildRolePermissions(viewerPages, ['view'], pages),
  };
}

export function createDefaultPermissionMatrixSync(): PermissionMatrix {
  const pages = pagesCache || DEFAULT_PAGES;
  const allPages = pages.map(({ key }) => key as PageKey);
  const allActions = [...DEFAULT_ACTIONS];
  const adminPages = allPages.filter((key) => !['users', 'activity'].includes(key));
  const viewerPages = allPages.filter((key) =>
    !['users', 'activity', 'settings', 'directory'].includes(key),
  );

  return {
    superadmin: buildRolePermissions(allPages, allActions, pages as typeof DEFAULT_PAGES),
    admin: buildRolePermissions(adminPages, ['view', 'create', 'edit', 'delete'], pages as typeof DEFAULT_PAGES),
    viewer: buildRolePermissions(viewerPages, ['view'], pages as typeof DEFAULT_PAGES),
  };
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && DEFAULT_ROLES.includes(value as Role);
}

export function isPageKey(value: unknown): value is PageKey {
  const pages = pagesCache || DEFAULT_PAGES;
  return typeof value === 'string' && pages.some((page) => page.key === value);
}

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && DEFAULT_ACTIONS.includes(value as PermissionAction);
}

export function validateRolePermissions(value: unknown): value is RolePermissions {
  const pages = pagesCache || DEFAULT_PAGES;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;

  return Object.keys(permissions).length === pages.length && pages.every(({ key }) => {
    const page = permissions[key];
    if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
    const actions = page as Record<string, unknown>;
    return Object.keys(actions).length === DEFAULT_ACTIONS.length &&
      DEFAULT_ACTIONS.every((action) => typeof actions[action] === 'boolean');
  });
}

export function hasPermission(
  role: Role,
  matrix: PermissionMatrix,
  page: PageKey,
  action: PermissionAction,
): boolean {
  return role === 'superadmin' || matrix[role][page][action];
}

export function getROLES(): readonly Role[] {
  return DEFAULT_ROLES;
}

export function getACTIONS(): readonly PermissionAction[] {
  return DEFAULT_ACTIONS;
}

export async function getPAGES(): Promise<typeof DEFAULT_PAGES> {
  return loadPagesFromDb();
}

export function getPAGESsync(): typeof DEFAULT_PAGES {
  return pagesCache || DEFAULT_PAGES;
}
