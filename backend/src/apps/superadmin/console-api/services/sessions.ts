import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
const IMPERSONATION_LAUNCH_TTL_MS = 60 * 1000;
const require = createRequire(import.meta.url);
const { pool } = require('../../../../config/energy_service/db.js') as { pool: Pool };

export interface SessionImpersonation {
  id: string;
  name: string;
  email: string;
}

export interface Session {
  userId: string;
  expiresAt: number;
  impersonatedBy?: SessionImpersonation;
  actorSessionHash?: string;
}

export interface ImpersonationLaunch {
  actorId: string;
  targetId: string;
  reason: string;
  expiresAt: number;
  actorSessionHash: string;
}

export interface SessionRepository {
  initialize?(): Promise<void>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<boolean>;
  createImpersonationSession(
    tokenHash: string, userId: string, impersonatedBy: SessionImpersonation,
    actorSessionHash: string, expiresAt: number,
  ): Promise<boolean>;
  getSession(tokenHash: string): Promise<Session | undefined>;
  createLaunch(
    tokenHash: string,
    actorId: string,
    targetId: string,
    reason: string,
    actorSessionHash: string,
    expiresAt: number,
  ): Promise<boolean>;
  consumeLaunch(tokenHash: string): Promise<ImpersonationLaunch | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  revokeOtherSessions(userId: string, exceptTokenHash: string): Promise<void>;
  revokeUserAccess(userId: string): Promise<void>;
}

type SessionRow = {
  user_id: string;
  expires_at: Date | string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_session_hash: string | null;
};

function hashCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly database: Pick<Pool, 'query'> = pool) {}

  async initialize(): Promise<void> {
    await this.database.query('CREATE SCHEMA IF NOT EXISTS superadmin');
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.console_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES superadmin.users (id) ON DELETE CASCADE,
        actor_id UUID REFERENCES superadmin.users (id) ON DELETE SET NULL,
        actor_name TEXT,
        actor_email TEXT,
        actor_session_hash CHAR(64)
          REFERENCES superadmin.console_sessions (token_hash) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((actor_id IS NULL) = (actor_session_hash IS NULL))
      )
    `);
    await this.database.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='superadmin' AND table_name='console_sessions'
            AND column_name='user_id' AND data_type='text'
        ) THEN
          ALTER TABLE superadmin.console_sessions
            ALTER COLUMN user_id TYPE UUID USING user_id::uuid;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='superadmin' AND table_name='console_sessions'
            AND column_name='actor_id' AND data_type='text'
        ) THEN
          ALTER TABLE superadmin.console_sessions
            ALTER COLUMN actor_id TYPE UUID USING actor_id::uuid;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname='console_sessions_user_fk'
        ) THEN
          ALTER TABLE superadmin.console_sessions
            ADD CONSTRAINT console_sessions_user_fk
            FOREIGN KEY (user_id) REFERENCES superadmin.users(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS console_sessions_user_id_idx
      ON superadmin.console_sessions (user_id)
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS console_sessions_expires_at_idx
      ON superadmin.console_sessions (expires_at)
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS console_sessions_actor_id_idx
      ON superadmin.console_sessions (actor_id)
      WHERE actor_id IS NOT NULL
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS superadmin.console_impersonation_launches (
        token_hash CHAR(64) PRIMARY KEY,
        actor_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor_session_hash CHAR(64) NOT NULL
          REFERENCES superadmin.console_sessions (token_hash) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS console_impersonation_target_id_idx
      ON superadmin.console_impersonation_launches (target_id)
    `);
    await this.database.query(`
      CREATE INDEX IF NOT EXISTS console_impersonation_expires_at_idx
      ON superadmin.console_impersonation_launches (expires_at)
    `);
  }

  async createSession(tokenHash: string, userId: string, expiresAt: number): Promise<boolean> {
    await this.database.query(
      'DELETE FROM superadmin.console_sessions WHERE expires_at <= NOW()',
    );
    const result = await this.database.query(
      `INSERT INTO superadmin.console_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, userId, new Date(expiresAt)],
    );
    return result.rowCount === 1;
  }

  async createImpersonationSession(
    tokenHash: string,
    userId: string,
    impersonatedBy: SessionImpersonation,
    actorSessionHash: string,
    expiresAt: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO superadmin.console_sessions
         (token_hash, user_id, actor_id, actor_name, actor_email, actor_session_hash, expires_at)
       SELECT $1, $2, $3, $4, $5, actor.token_hash, $6
       FROM superadmin.console_sessions AS actor
       WHERE actor.token_hash = $7
         AND actor.user_id = $3
         AND actor.actor_id IS NULL
         AND actor.expires_at > NOW()
       ON CONFLICT (token_hash) DO NOTHING`,
      [
        tokenHash,
        userId,
        impersonatedBy.id,
        impersonatedBy.name,
        impersonatedBy.email,
        new Date(expiresAt),
        actorSessionHash,
      ],
    );
    return result.rowCount === 1;
  }

  async getSession(tokenHash: string): Promise<Session | undefined> {
    const result = await this.database.query<SessionRow>(
      `SELECT sess.user_id, sess.expires_at,
              sess.actor_id, sess.actor_name, sess.actor_email,
              sess.actor_session_hash
       FROM superadmin.console_sessions AS sess
       WHERE sess.token_hash = $1
         AND sess.expires_at > NOW()
         AND (
           sess.actor_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM superadmin.console_sessions AS actor
             WHERE actor.token_hash = sess.actor_session_hash
               AND actor.user_id = sess.actor_id
               AND actor.actor_id IS NULL
               AND actor.expires_at > NOW()
           )
         )`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      await this.database.query(
        `DELETE FROM superadmin.console_sessions
         WHERE token_hash = $1 AND expires_at <= NOW()`,
        [tokenHash],
      );
      return undefined;
    }
    return {
      userId: row.user_id,
      expiresAt: new Date(row.expires_at).getTime(),
      ...(row.actor_id ? {
        impersonatedBy: {
          id: row.actor_id,
          name: row.actor_name ?? '',
          email: row.actor_email ?? '',
        },
        actorSessionHash: row.actor_session_hash ?? undefined,
      } : {}),
    };
  }

  async createLaunch(
    tokenHash: string,
    actorId: string,
    targetId: string,
    reason: string,
    actorSessionHash: string,
    expiresAt: number,
  ): Promise<boolean> {
    await this.database.query(
      'DELETE FROM superadmin.console_impersonation_launches WHERE expires_at <= NOW()',
    );
    const result = await this.database.query(
      `INSERT INTO superadmin.console_impersonation_launches
         (token_hash, actor_id, target_id, reason, actor_session_hash, expires_at)
       SELECT $1, $2, $3, $4, actor.token_hash, $5
       FROM superadmin.console_sessions AS actor
       WHERE actor.token_hash = $6
         AND actor.user_id = $2
         AND actor.actor_id IS NULL
         AND actor.expires_at > NOW()
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, actorId, targetId, reason, new Date(expiresAt), actorSessionHash],
    );
    return result.rowCount === 1;
  }

  async consumeLaunch(tokenHash: string): Promise<ImpersonationLaunch | undefined> {
    const result = await this.database.query<{
      actor_id: string;
      target_id: string;
      reason: string;
      expires_at: Date | string;
      actor_session_hash: string;
    }>(
      `DELETE FROM superadmin.console_impersonation_launches AS launch
       USING superadmin.console_sessions AS actor
       WHERE launch.token_hash = $1
         AND launch.expires_at > NOW()
         AND actor.token_hash = launch.actor_session_hash
         AND actor.user_id = launch.actor_id
         AND actor.actor_id IS NULL
         AND actor.expires_at > NOW()
       RETURNING launch.actor_id, launch.target_id, launch.reason,
                 launch.expires_at, launch.actor_session_hash`,
      [tokenHash],
    );
    const launch = result.rows[0];
    return launch ? {
      actorId: launch.actor_id,
      targetId: launch.target_id,
      reason: launch.reason,
      expiresAt: new Date(launch.expires_at).getTime(),
      actorSessionHash: launch.actor_session_hash,
    } : undefined;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.database.query(
      'DELETE FROM superadmin.console_sessions WHERE token_hash = $1',
      [tokenHash],
    );
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.database.query(
      'DELETE FROM superadmin.console_sessions WHERE user_id = $1',
      [userId],
    );
  }

  async revokeOtherSessions(userId: string, exceptTokenHash: string): Promise<void> {
    await this.database.query(
      'DELETE FROM superadmin.console_sessions WHERE user_id = $1 AND token_hash <> $2',
      [userId, exceptTokenHash],
    );
  }

  async revokeUserAccess(userId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM superadmin.console_sessions
       WHERE user_id = $1 OR actor_id = $1`,
      [userId],
    );
    await this.database.query(
      'DELETE FROM superadmin.console_impersonation_launches WHERE target_id = $1',
      [userId],
    );
  }
}

export class SessionManager {
  constructor(private readonly repository: SessionRepository = new PostgresSessionRepository()) {}

  async initialize(): Promise<void> {
    await this.repository.initialize?.();
  }

  async create(userId: string): Promise<{ id: string; expiresAt: number }> {
    await this.repository.revokeUserSessions(userId);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    if (!(await this.repository.createSession(hashCredential(id), userId, expiresAt))) {
      throw new Error('Unable to create the authenticated session.');
    }
    return { id, expiresAt };
  }

  async createImpersonationLaunch(
    actorId: string,
    targetId: string,
    actorSessionId: string,
    reason: string,
  ): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + IMPERSONATION_LAUNCH_TTL_MS;
    const created = await this.repository.createLaunch(
      hashCredential(token),
      actorId,
      targetId,
      reason,
      hashCredential(actorSessionId),
      expiresAt,
    );
    if (!created) throw new InvalidSessionError();
    return { token, expiresAt };
  }

  async consumeImpersonationLaunch(
    token: string,
  ): Promise<ImpersonationLaunch | undefined> {
    return this.repository.consumeLaunch(hashCredential(token));
  }

  async createImpersonationSession(
    userId: string,
    impersonatedBy: SessionImpersonation,
    actorSessionHash: string,
  ): Promise<{ id: string; expiresAt: number }> {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + IMPERSONATION_TTL_MS;
    const created = await this.repository.createImpersonationSession(
      hashCredential(id),
      userId,
      impersonatedBy,
      actorSessionHash,
      expiresAt,
    );
    if (!created) throw new InvalidSessionError();
    return { id, expiresAt };
  }

  async get(id: string): Promise<Session | undefined> {
    return this.repository.getSession(hashCredential(id));
  }

  auditReference(id: string): string {
    return hashCredential(id);
  }

  async revoke(id: string): Promise<void> {
    await this.repository.revokeSession(hashCredential(id));
  }

  async revokeOtherSessions(userId: string, exceptSessionId: string): Promise<void> {
    await this.repository.revokeOtherSessions(userId, hashCredential(exceptSessionId));
  }

  async revokeUserAccess(userId: string): Promise<void> {
    await this.repository.revokeUserAccess(userId);
  }
}

export class InvalidSessionError extends Error {}
