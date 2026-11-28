import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createDefaultPermissionMatrixSync,
  isRole,
  getPAGESsync,
  getROLES,
  validateRolePermissions,
  type PermissionMatrix,
  type Role,
} from '../domain/permissions.js';
import type { AuditEvent, CompanyProfile, PersistentState, StoredUser } from '../domain/models.js';

const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  companyName: '',
  phone: '',
  email: '',
  gstin: '',
};
const USER_CODE_PATTERN = /^\d{3}-[A-Z]{2}_$/;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isCompanyProfile(value: unknown): value is CompanyProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<CompanyProfile>;
  return typeof profile.companyName === 'string' &&
    typeof profile.phone === 'string' &&
    typeof profile.email === 'string' &&
    typeof profile.gstin === 'string';
}

function isPermissionAssigner(
  value: unknown,
): value is { id: string; name: string; email: string } {
  if (!value || typeof value !== 'object') return false;
  const assigner = value as { id?: unknown; name?: unknown; email?: unknown };
  return typeof assigner.id === 'string' &&
    typeof assigner.name === 'string' &&
    typeof assigner.email === 'string';
}

export function isPersistentState(value: unknown): value is PersistentState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PersistentState>;
  return (
    (state.version === 1 || state.version === 2) &&
    Array.isArray(state.users) &&
    !!state.permissions &&
    getROLES().every((role) => validateRolePermissions(state.permissions?.[role])) &&
    state.users.every((user) =>
      !!user &&
      typeof user.id === 'string' &&
      (!('userCode' in user) || typeof user.userCode === 'string') &&
      typeof user.name === 'string' &&
      typeof user.email === 'string' &&
      isRole(user.role) &&
      typeof user.disabled === 'boolean' &&
      typeof user.passwordSalt === 'string' &&
      typeof user.passwordHash === 'string' &&
      typeof user.createdAt === 'string' &&
      typeof user.updatedAt === 'string' &&
      (!('permissionsAssignedBy' in user) || user.permissionsAssignedBy === null ||
        isPermissionAssigner(user.permissionsAssignedBy)) &&
      (!('phone' in user) || user.phone === null || typeof user.phone === 'string') &&
      (!('avatarFile' in user) || user.avatarFile === null ||
        (typeof user.avatarFile === 'string' && /^[0-9a-f-]{36}\.img$/.test(user.avatarFile))) &&
      (!('avatarContentType' in user) || user.avatarContentType === null ||
        user.avatarContentType === 'image/jpeg' ||
        user.avatarContentType === 'image/png' ||
        user.avatarContentType === 'image/webp') &&
      (!('profileCompletedAt' in user) || user.profileCompletedAt === null ||
        typeof user.profileCompletedAt === 'string') &&
      (!('permissions' in user) || validateRolePermissions(user.permissions)),
    ) &&
    (!('companyProfile' in state) || isCompanyProfile(state.companyProfile)) &&
    Array.isArray(state.auditEvents) &&
    state.auditEvents.every((event) =>
      !!event &&
      typeof event.id === 'string' &&
      typeof event.at === 'string' &&
      (typeof event.actorId === 'string' || event.actorId === null) &&
      (typeof event.actorEmail === 'string' || event.actorEmail === null) &&
      typeof event.action === 'string' &&
      typeof event.targetType === 'string' &&
      typeof event.targetId === 'string' &&
      !!event.details &&
      typeof event.details === 'object' &&
      !Array.isArray(event.details),
    )
  );
}

export class JsonStore {
  protected writeQueue: Promise<void> = Promise.resolve();

  constructor(
    protected readonly filePath: string | undefined,
    private readonly configuredAvatarDirectory?: string,
  ) {}

  private get avatarDirectory(): string {
    if (this.configuredAvatarDirectory) return this.configuredAvatarDirectory;
    if (!this.filePath) throw new Error('A storage path is required for JSON-backed avatars.');
    return `${this.filePath}.avatars`;
  }

  async initialize(bootstrap: {
    email: string;
    name: string;
    passwordSalt: string;
    passwordHash: string;
  }): Promise<void> {
    try {
      const state = await this.readState();
      let changed = false;
      if (state.version === 1) {
        const noDirectoryAccess = { view: false, create: false, edit: false, delete: false };
        state.version = 2;
        state.permissions.viewer.directory = { ...noDirectoryAccess };
        for (const user of state.users) {
          if (user.role === 'viewer' && user.permissions) {
            user.permissions.directory = { ...noDirectoryAccess };
          }
        }
        state.auditEvents.push({
          id: randomUUID(),
          at: new Date().toISOString(),
          actorId: null,
          actorEmail: null,
          action: 'system.access_policy_migrated',
          targetType: 'role',
          targetId: 'viewer',
          details: { page: 'directory', access: 'revoked' },
        });
        changed = true;
      }
      if (this.ensureUserCodes(state)) changed = true;
      if (changed) await this.writeState(state);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }

    if (!bootstrap.email || !bootstrap.passwordSalt || !bootstrap.passwordHash) {
      throw new Error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD before first startup.');
    }

    const now = new Date().toISOString();
    const state: PersistentState = {
      version: 2,
      users: [
        {
          id: randomUUID(),
          userCode: this.createUserCode(new Set()),
          name: bootstrap.name,
          email: bootstrap.email.trim().toLowerCase(),
          phone: null,
          avatarFile: null,
          avatarContentType: null,
          role: 'superadmin',
          disabled: false,
          passwordSalt: bootstrap.passwordSalt,
          passwordHash: bootstrap.passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      ],
      permissions: createDefaultPermissionMatrixSync(),
      auditEvents: [
        {
          id: randomUUID(),
          at: now,
          actorId: null,
          actorEmail: null,
          action: 'system.bootstrap',
          targetType: 'user',
          targetId: 'superadmin',
          details: { email: bootstrap.email.trim().toLowerCase() },
        },
      ],
    };
    await this.writeState(state);
  }

  async listUsers(): Promise<StoredUser[]> {
    return (await this.readState()).users;
  }

  async getUserById(id: string): Promise<StoredUser | undefined> {
    return (await this.readState()).users.find((user) => user.id === id);
  }

  async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    const normalizedEmail = email.trim().toLowerCase();
    return (await this.readState()).users.find((user) => user.email === normalizedEmail);
  }

  async getPermissions(): Promise<PermissionMatrix> {
    return (await this.readState()).permissions;
  }

  async getCompanyProfile(): Promise<CompanyProfile> {
    const state = await this.readState();
    return state.companyProfile ?? { ...DEFAULT_COMPANY_PROFILE };
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    return (await this.readState()).auditEvents.slice().reverse();
  }

  async addUser(user: StoredUser, actor: StoredUser): Promise<StoredUser> {
    return this.mutate((state) => {
      if (state.users.some((existing) => existing.email === user.email)) {
        throw new StoreConflictError('An account with this email already exists.');
      }
      const createdUser = {
        ...user,
        userCode: this.createUserCode(
          new Set(state.users.map((existing) => existing.userCode).filter(
            (code): code is string => typeof code === 'string',
          )),
        ),
      };
      state.users.push(createdUser);
      state.auditEvents.push(this.audit(actor, 'user.created', 'user', createdUser.id, {
        email: createdUser.email,
        role: createdUser.role,
      }));
      return createdUser;
    });
  }

  async updateUser(
    id: string,
    changes: Pick<StoredUser, 'role' | 'disabled'>,
    actor: StoredUser,
  ): Promise<StoredUser | undefined> {
    return this.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) return undefined;
      const previous = { role: user.role, disabled: user.disabled };
      user.role = changes.role;
      user.disabled = changes.disabled;
      if (changes.role === 'admin' && previous.role !== 'admin') {
        user.profileCompletedAt = null;
      }
      user.updatedAt = new Date().toISOString();
      state.auditEvents.push(this.audit(actor, 'user.updated', 'user', user.id, {
        previousRole: previous.role,
        role: changes.role,
        previousDisabled: previous.disabled,
        disabled: changes.disabled,
      }));
      return user;
    });
  }

  async deleteUser(id: string, actor: StoredUser): Promise<StoredUser | undefined> {
    const deleted = await this.mutate((state) => {
      const index = state.users.findIndex((candidate) => candidate.id === id);
      if (index < 0) return undefined;
      const [user] = state.users.splice(index, 1);
      state.auditEvents.push(this.audit(actor, 'user.deleted', 'user', user.id, {
        email: user.email,
        role: user.role,
      }));
      return { user, avatarFile: user.avatarFile ?? null };
    });
    if (!deleted) return undefined;
    if (deleted.avatarFile) {
      await rm(join(this.avatarDirectory, deleted.avatarFile), { force: true });
    }
    return deleted.user;
  }

  async updateUserPermissions(
    id: string,
    permissions: StoredUser['permissions'] | null,
    actor: StoredUser,
  ): Promise<StoredUser | undefined> {
    return this.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) return undefined;

      const previous = user.permissions ?? state.permissions[user.role];
      const updated = permissions ?? state.permissions[user.role];
      const changed: Record<string, string | boolean | number | null> = {};
      for (const { key } of getPAGESsync()) {
        for (const action of ['view', 'create', 'edit', 'delete'] as const) {
          if (previous[key][action] !== updated[key][action]) {
            changed[`${key}.${action}`] = updated[key][action];
          }
        }
      }

      if (permissions) user.permissions = permissions;
      else delete user.permissions;
      if (permissions) {
        user.permissionsAssignedBy = {
          id: actor.id,
          name: actor.name,
          email: actor.email,
        };
      } else {
        delete user.permissionsAssignedBy;
      }
      user.updatedAt = new Date().toISOString();
      state.auditEvents.push(this.audit(actor, 'user.permissions_updated', 'user', user.id, {
        email: user.email,
        mode: permissions ? 'custom' : 'role_default',
        ...changed,
      }));
      return user;
    });
  }

  async updateProfile(
    id: string,
    changes: { name: string; phone: string | null; completeSetup?: boolean },
    actor: StoredUser,
  ): Promise<StoredUser | undefined> {
    return this.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) return undefined;
      const nameChanged = user.name !== changes.name;
      const phoneChanged = (user.phone ?? null) !== changes.phone;
      const setupCompleted = changes.completeSetup === true && !user.profileCompletedAt;
      if (!nameChanged && !phoneChanged && !setupCompleted) return user;

      const now = new Date().toISOString();
      user.name = changes.name;
      user.phone = changes.phone;
      if (changes.completeSetup) user.profileCompletedAt = now;
      user.updatedAt = now;
      state.auditEvents.push(this.audit(actor, 'user.profile_updated', 'user', user.id, {
        nameChanged,
        phoneChanged,
        setupCompleted,
      }));
      return user;
    });
  }

  async updatePassword(
    id: string,
    credentials: { passwordSalt: string; passwordHash: string },
    actor: StoredUser,
  ): Promise<StoredUser | undefined> {
    return this.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) return undefined;
      user.passwordSalt = credentials.passwordSalt;
      user.passwordHash = credentials.passwordHash;
      user.updatedAt = new Date().toISOString();
      state.auditEvents.push(this.audit(actor, 'auth.password_changed', 'user', user.id, {}));
      return user;
    });
  }

  async updateCompanyProfile(
    companyProfile: CompanyProfile,
    actor: StoredUser,
  ): Promise<CompanyProfile> {
    return this.mutate((state) => {
      const previous = state.companyProfile ?? DEFAULT_COMPANY_PROFILE;
      const changed = Object.keys(companyProfile).some(
        (key) => previous[key as keyof CompanyProfile] !== companyProfile[key as keyof CompanyProfile],
      );
      if (!changed) return { ...previous };
      state.companyProfile = { ...companyProfile };
      state.auditEvents.push(this.audit(actor, 'company.profile_updated', 'company', 'platform', {
        companyNameChanged: previous.companyName !== companyProfile.companyName,
        phoneChanged: previous.phone !== companyProfile.phone,
        emailChanged: previous.email !== companyProfile.email,
        gstinChanged: previous.gstin !== companyProfile.gstin,
      }));
      return { ...companyProfile };
    });
  }

  async updateAvatar(
    id: string,
    avatar: { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer } | null,
    actor: StoredUser,
  ): Promise<StoredUser | undefined> {
    if (avatar && !this.isValidAvatar(avatar.contentType, avatar.bytes)) {
      throw new InvalidProfileImageError('The profile image format or size is invalid.');
    }

    const newFile = avatar ? `${randomUUID()}.img` : null;
    if (avatar && newFile) {
      await mkdir(this.avatarDirectory, { recursive: true, mode: 0o700 });
      const tempFile = join(this.avatarDirectory, `${randomUUID()}.tmp`);
      try {
        await writeFile(tempFile, avatar.bytes, { flag: 'wx', mode: 0o600 });
        await rename(tempFile, join(this.avatarDirectory, newFile));
      } catch (error) {
        await rm(tempFile, { force: true });
        throw error;
      }
    }

    let result: { user: StoredUser; previousFile: string | null } | undefined;
    try {
      result = await this.mutate((state) => {
        const user = state.users.find((candidate) => candidate.id === id);
        if (!user) return undefined;
        const previousFile = user.avatarFile ?? null;
        const changed = previousFile !== newFile ||
          (avatar !== null && user.avatarContentType !== avatar.contentType);
        if (!changed) return { user, previousFile: null };

        user.avatarFile = newFile;
        user.avatarContentType = avatar?.contentType ?? null;
        user.updatedAt = new Date().toISOString();
        state.auditEvents.push(this.audit(
          actor,
          avatar ? 'user.avatar_updated' : 'user.avatar_removed',
          'user',
          user.id,
          {},
        ));
        return { user, previousFile };
      });
    } catch (error) {
      if (newFile) await rm(join(this.avatarDirectory, newFile), { force: true });
      throw error;
    }
    if (!result) {
      if (newFile) await rm(join(this.avatarDirectory, newFile), { force: true });
      return undefined;
    }
    if (result.previousFile && result.previousFile !== newFile) {
      await rm(join(this.avatarDirectory, result.previousFile), { force: true });
    }
    return result.user;
  }

  async hasAvatar(id: string): Promise<boolean> {
    const user = await this.getUserById(id);
    return !!user?.avatarFile && !!user.avatarContentType;
  }

  async getAvatar(
    id: string,
  ): Promise<{ contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer } | null> {
    const user = await this.getUserById(id);
    if (!user?.avatarFile || !user.avatarContentType) return null;
    return {
      contentType: user.avatarContentType,
      bytes: await readFile(join(this.avatarDirectory, user.avatarFile)),
    };
  }

  async updateRolePermissions(
    role: Role,
    permissions: PermissionMatrix[Role],
    actor: StoredUser,
  ): Promise<void> {
    await this.mutate((state) => {
      const previous = state.permissions[role];
      const changes: Record<string, string | boolean | number | null> = {};
      for (const { key } of getPAGESsync()) {
        for (const action of ['view', 'create', 'edit', 'delete'] as const) {
          if (previous[key][action] !== permissions[key][action]) {
            changes[`${key}.${action}`] = permissions[key][action];
          }
        }
      }
      state.permissions[role] = permissions;
      state.auditEvents.push(this.audit(actor, 'permissions.updated', 'role', role, changes));
    });
  }

  async recordAudit(
    actor: StoredUser | null,
    action: string,
    targetType: string,
    targetId: string,
    details: AuditEvent['details'] = {},
  ): Promise<void> {
    await this.mutate((state) => {
      state.auditEvents.push(this.audit(actor, action, targetType, targetId, details));
    });
  }

  private audit(
    actor: StoredUser | null,
    action: string,
    targetType: string,
    targetId: string,
    details: AuditEvent['details'],
  ): AuditEvent {
    const auditDetails = actor?.impersonatedBy
      ? {
          ...details,
          impersonatedById: actor.impersonatedBy.id,
          impersonatedByEmail: actor.impersonatedBy.email,
        }
      : details;
    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action,
      targetType,
      targetId,
      details: auditDetails,
    };
  }

  private isValidAvatar(
    contentType: 'image/jpeg' | 'image/png' | 'image/webp',
    bytes: Buffer,
  ): boolean {
    if (bytes.length === 0 || bytes.length > 512 * 1024) return false;
    if (contentType === 'image/jpeg') {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (contentType === 'image/png') {
      return bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    return bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP';
  }

  private ensureUserCodes(state: PersistentState): boolean {
    const usedCodes = new Set<string>();
    let changed = false;
    for (const user of state.users) {
      if (
        typeof user.userCode === 'string' &&
        USER_CODE_PATTERN.test(user.userCode) &&
        !usedCodes.has(user.userCode)
      ) {
        usedCodes.add(user.userCode);
        continue;
      }
      user.userCode = this.createUserCode(usedCodes);
      usedCodes.add(user.userCode);
      changed = true;
    }
    return changed;
  }

  private createUserCode(usedCodes: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const digits = `${randomInt(10)}${randomInt(10)}${randomInt(10)}`;
      const letters = `${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
      const code = `${digits}-${letters}_`;
      if (!usedCodes.has(code)) return code;
    }
    throw new Error('Unable to generate a unique user reference code.');
  }

  protected async mutate<T>(change: (state: PersistentState) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const state = await this.readState();
      const result = change(state);
      await this.writeState(state);
      return result;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  protected async readState(): Promise<PersistentState> {
    if (!this.filePath) throw new Error('A storage path is required for JSON-backed state.');
    const contents = await readFile(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`The access-control file contains invalid JSON: ${String(error)}`);
    }
    if (!isPersistentState(parsed)) {
      throw new Error('The access-control file has an unsupported or invalid structure.');
    }
    return parsed;
  }

  protected async writeState(state: PersistentState): Promise<void> {
    if (!this.filePath) throw new Error('A storage path is required for JSON-backed state.');
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

export class StoreConflictError extends Error {}
export class InvalidProfileImageError extends Error {}


