import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { AuditEvent, PersistentState, StoredUser } from '../domain/models.js';
import { createDefaultPermissionMatrixSync, getPAGESsync, getROLES, type PermissionMatrix, type Role } from '../domain/permissions.js';
import { isPersistentState, JsonStore } from './json-store.js';

const require = createRequire(import.meta.url);
const { pool } = require('../../../../config/energy_service/db.js') as { pool: Pool };
const { getPrivateUploadsDir } = require('../../../../config/shared.js') as {
  getPrivateUploadsDir: () => string;
};

type Queryable = Pick<Pool, 'query' | 'connect'>;

export class PostgresStore extends JsonStore {
  constructor(filePath: string | undefined, private readonly database: Queryable = pool) {
    super(filePath, join(getPrivateUploadsDir(), 'superadmin-avatars'));
  }

  override async initialize(bootstrap: {
    email: string;
    name: string;
    passwordSalt: string;
    passwordHash: string;
  }): Promise<void> {
    await this.database.query('CREATE SCHEMA IF NOT EXISTS superadmin');
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.users (
        id UUID PRIMARY KEY,
        public_user_id UUID REFERENCES public.users (id) ON DELETE SET NULL,
        user_code VARCHAR(16) UNIQUE,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20),
        role VARCHAR(20) NOT NULL,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_file VARCHAR(64),
        avatar_content_type VARCHAR(32),
        profile_completed_at TIMESTAMPTZ,
        permissions_assigned_by_id UUID REFERENCES superadmin.users (id) ON DELETE SET NULL,
        permissions_assigned_by_name VARCHAR(120),
        permissions_assigned_by_email VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.role_permissions (
        role VARCHAR(20) NOT NULL,
        page VARCHAR(40) NOT NULL,
        can_view BOOLEAN NOT NULL DEFAULT FALSE,
        can_create BOOLEAN NOT NULL DEFAULT FALSE,
        can_edit BOOLEAN NOT NULL DEFAULT FALSE,
        can_delete BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (role, page)
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.user_permissions (
        user_id UUID NOT NULL REFERENCES superadmin.users (id) ON DELETE CASCADE,
        page VARCHAR(40) NOT NULL,
        can_view BOOLEAN NOT NULL DEFAULT FALSE,
        can_create BOOLEAN NOT NULL DEFAULT FALSE,
        can_edit BOOLEAN NOT NULL DEFAULT FALSE,
        can_delete BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (user_id, page)
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.audit_events (
        id UUID PRIMARY KEY,
        actor_id UUID REFERENCES superadmin.users (id) ON DELETE SET NULL,
        actor_email VARCHAR(255),
        action VARCHAR(120) NOT NULL,
        target_type VARCHAR(40) NOT NULL,
        target_id VARCHAR(255) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.company_profile (
        singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
        company_name VARCHAR(255) NOT NULL DEFAULT '',
        phone VARCHAR(40) NOT NULL DEFAULT '',
        email VARCHAR(255) NOT NULL DEFAULT '',
        gstin VARCHAR(40) NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS superadmin_audit_actor_idx
      ON superadmin.audit_events (actor_id, occurred_at)
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS superadmin_audit_target_idx
      ON superadmin.audit_events (target_type, target_id)
    `);
    await this.importLegacyDatabaseStateIfNeeded();
    await this.database.query('DROP TABLE IF EXISTS superadmin.console_state');
    await super.initialize(bootstrap);
    const root = await this.database.query(
      'SELECT id FROM superadmin.users WHERE LOWER(email) = LOWER($1)',
      [bootstrap.email.trim().toLowerCase()],
    );
    if (!root.rows[0]) {
      await this.database.query(
        `INSERT INTO superadmin.users (
           id, name, email, role, disabled, password_salt, password_hash,
           created_at, updated_at
         ) VALUES ($1,$2,$3,'superadmin',FALSE,$4,$5,NOW(),NOW())`,
        [
          randomUUID(),
          bootstrap.name.trim(),
          bootstrap.email.trim().toLowerCase(),
          bootstrap.passwordSalt,
          bootstrap.passwordHash,
        ],
      );
    }
    await this.database.query(
      `UPDATE superadmin.users
       SET name = $2,
           password_salt = $3,
           password_hash = $4,
           updated_at = NOW()
       WHERE LOWER(email) = LOWER($1)`,
      [bootstrap.email.trim().toLowerCase(), bootstrap.name.trim(), bootstrap.passwordSalt, bootstrap.passwordHash],
    );
  }

  private async importLegacyDatabaseStateIfNeeded(): Promise<void> {
    const table = await this.database.query<{ exists: boolean }>(`
      SELECT to_regclass('superadmin.console_state') IS NOT NULL AS exists
    `);
    if (!table.rows[0]?.exists) return;
    const users = await this.database.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM superadmin.users',
    );
    if (Number(users.rows[0]?.count ?? 0) > 0) return;
    const result = await this.database.query<{ state: unknown }>(
      'SELECT state FROM superadmin.console_state WHERE singleton = 1',
    );
    if (!result.rows[0] || !isPersistentState(result.rows[0].state)) return;
    await this.writeState(result.rows[0].state);
  }

  protected override async readState(): Promise<PersistentState> {
    const usersResult = await this.database.query<any>(`
      SELECT id, user_code, name, email, phone, role, disabled,
             password_salt, password_hash, avatar_file, avatar_content_type,
             profile_completed_at, permissions_assigned_by_id,
             permissions_assigned_by_name, permissions_assigned_by_email,
             created_at, updated_at
      FROM superadmin.users
      ORDER BY created_at, id
    `);
    if (!usersResult.rows.length) {
      const error = new Error('Superadmin database state is not initialized.') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }

    const roleRows = await this.database.query<any>(`
      SELECT role, page, can_view, can_create, can_edit, can_delete
      FROM superadmin.role_permissions
    `);
    const customRows = await this.database.query<any>(`
      SELECT user_id, page, can_view, can_create, can_edit, can_delete
      FROM superadmin.user_permissions
    `);
    const auditRows = await this.database.query<any>(`
      SELECT id, actor_id, actor_email, action, target_type, target_id, details, occurred_at
      FROM superadmin.audit_events
      ORDER BY occurred_at ASC, id ASC
    `);
    const profileRows = await this.database.query<any>(`
      SELECT company_name, phone, email, gstin
      FROM superadmin.company_profile
      WHERE singleton = 1
    `);

    const permissions = createDefaultPermissionMatrixSync();
    for (const row of roleRows.rows) {
      if (!getROLES().includes(row.role as Role)) continue;
      if (!getPAGESsync().some((page) => page.key === row.page)) continue;
      const key = row.page as string;
      permissions[row.role as Role][key] = {
        view: row.can_view,
        create: row.can_create,
        edit: row.can_edit,
        delete: row.can_delete,
      };
    }

    const users: StoredUser[] = usersResult.rows.map((row) => {
      const custom: Partial<PermissionMatrix[Role]> = {};
      for (const permission of customRows.rows.filter((entry) => entry.user_id === row.id)) {
        if (!getPAGESsync().some((page) => page.key === permission.page)) continue;
        const key = permission.page as string;
        custom[key] = {
          view: permission.can_view,
          create: permission.can_create,
          edit: permission.can_edit,
          delete: permission.can_delete,
        };
      }
      const permissionsAssignedBy = row.permissions_assigned_by_id
        ? {
            id: row.permissions_assigned_by_id,
            name: row.permissions_assigned_by_name,
            email: row.permissions_assigned_by_email,
          }
        : null;
      return {
        id: row.id,
        userCode: row.user_code ?? undefined,
        name: row.name,
        email: row.email,
        phone: row.phone,
        role: row.role as Role,
        disabled: row.disabled,
        passwordSalt: row.password_salt,
        passwordHash: row.password_hash,
        avatarFile: row.avatar_file,
        avatarContentType: row.avatar_content_type,
        profileCompletedAt: row.profile_completed_at
          ? new Date(row.profile_completed_at).toISOString()
          : null,
        permissionsAssignedBy,
        permissions: Object.keys(custom).length
          ? custom as PermissionMatrix[Role]
          : undefined,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });

    const auditEvents: AuditEvent[] = auditRows.rows.map((row) => ({
      id: row.id,
      at: new Date(row.occurred_at).toISOString(),
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details ?? {},
    }));

    const profile = profileRows.rows[0];
    return {
      version: 2,
      users,
      permissions,
      auditEvents,
      companyProfile: profile ? {
        companyName: profile.company_name,
        phone: profile.phone,
        email: profile.email,
        gstin: profile.gstin,
      } : { companyName: '', phone: '', email: '', gstin: '' },
    };
  }

  protected override async writeState(state: PersistentState): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.syncState(client, state);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  protected override async mutate<T>(change: (state: PersistentState) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const state = await this.readState();
      const client: PoolClient = await this.database.connect();
      try {
        await client.query('BEGIN');
        const value = change(state);
        await this.syncState(client, state);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async syncState(client: PoolClient, state: PersistentState): Promise<void> {
    const ids = state.users.map((user) => user.id);
    await client.query(
      `DELETE FROM superadmin.users
       WHERE NOT (id = ANY($1::uuid[]))`,
      [ids],
    );
    for (const user of state.users) {
      await client.query(
        `INSERT INTO superadmin.users (
           id, user_code, name, email, phone, role, disabled,
           password_salt, password_hash, avatar_file, avatar_content_type,
           profile_completed_at, permissions_assigned_by_id,
           permissions_assigned_by_name, permissions_assigned_by_email,
           created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
         )
         ON CONFLICT (id) DO UPDATE SET
           user_code = EXCLUDED.user_code,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           role = EXCLUDED.role,
           disabled = EXCLUDED.disabled,
           password_salt = EXCLUDED.password_salt,
           password_hash = EXCLUDED.password_hash,
           avatar_file = EXCLUDED.avatar_file,
           avatar_content_type = EXCLUDED.avatar_content_type,
           profile_completed_at = EXCLUDED.profile_completed_at,
           permissions_assigned_by_id = EXCLUDED.permissions_assigned_by_id,
           permissions_assigned_by_name = EXCLUDED.permissions_assigned_by_name,
           permissions_assigned_by_email = EXCLUDED.permissions_assigned_by_email,
           updated_at = EXCLUDED.updated_at`,
        [
          user.id,
          user.userCode ?? null,
          user.name,
          user.email,
          user.phone ?? null,
          user.role,
          user.disabled,
          user.passwordSalt,
          user.passwordHash,
          user.avatarFile ?? null,
          user.avatarContentType ?? null,
          user.profileCompletedAt ?? null,
          user.permissionsAssignedBy?.id ?? null,
          user.permissionsAssignedBy?.name ?? null,
          user.permissionsAssignedBy?.email ?? null,
          user.createdAt,
          user.updatedAt,
        ],
      );
      await client.query('DELETE FROM superadmin.user_permissions WHERE user_id = $1', [user.id]);
      if (user.permissions) {
        for (const page of getPAGESsync()) {
          const permissions = user.permissions[page.key];
          if (!permissions) continue;
          await client.query(
            `INSERT INTO superadmin.user_permissions (
               user_id, page, can_view, can_create, can_edit, can_delete
             ) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id, page) DO UPDATE SET
               can_view = EXCLUDED.can_view,
               can_create = EXCLUDED.can_create,
               can_edit = EXCLUDED.can_edit,
               can_delete = EXCLUDED.can_delete`,
            [user.id, page.key, permissions.view, permissions.create, permissions.edit, permissions.delete],
          );
        }
      }
    }

    for (const role of getROLES()) {
      for (const page of getPAGESsync()) {
        const permissions = state.permissions[role][page.key];
        await client.query(
          `INSERT INTO superadmin.role_permissions (
             role, page, can_view, can_create, can_edit, can_delete
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (role, page) DO UPDATE SET
             can_view = EXCLUDED.can_view,
             can_create = EXCLUDED.can_create,
             can_edit = EXCLUDED.can_edit,
             can_delete = EXCLUDED.can_delete`,
          [role, page.key, permissions.view, permissions.create, permissions.edit, permissions.delete],
        );
      }
    }

    for (const event of state.auditEvents) {
      await client.query(
        `INSERT INTO superadmin.audit_events (
           id, actor_id, actor_email, action, target_type, target_id, details, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.actorId,
          event.actorEmail,
          event.action,
          event.targetType,
          event.targetId,
          JSON.stringify(event.details),
          event.at,
        ],
      );
    }

    const profile = state.companyProfile ?? { companyName: '', phone: '', email: '', gstin: '' };
    await client.query(
      `INSERT INTO superadmin.company_profile (
         singleton, company_name, phone, email, gstin, updated_at
       ) VALUES (1,$1,$2,$3,$4,NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         company_name = EXCLUDED.company_name,
         phone = EXCLUDED.phone,
         email = EXCLUDED.email,
         gstin = EXCLUDED.gstin,
         updated_at = NOW()`,
      [profile.companyName, profile.phone, profile.email, profile.gstin],
    );
  }
}
