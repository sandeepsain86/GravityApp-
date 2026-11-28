/**
 * Database access layer.
 *
 * The runtime connects to PostgreSQL using the shared DB_* settings.
 * SQLite URLs are accepted only by isolated smoke tests.
 *
 * A test may set DATABASE_URL=sqlite://./data/smoke_test.db before loading
 * configuration; normal development and production never need that variable.
 */

const path = require('path');
const config = require('../../config/energy_provider/env');
const { tables } = require('./schema');
const { renderTable, renderIndex, renderType, quote } = require('./dialect');

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');

const parseDatabaseUrl = (url) => {
  if (!url) {
    return {
      driver: 'postgres',
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      ssl: config.DB_SSL_OPTIONS,
    };
  }

  const match = /^([a-z0-9+]+):\/\/(.*)$/i.exec(url);
  if (!match) {
    throw new Error('Invalid test database URL; expected sqlite:// or a supported database scheme.');
  }

  const scheme = match[1].toLowerCase();
  const rest = match[2];

  if (scheme === 'sqlite') {
    const file = rest.replace(/^\/\//, '');
    if (!file) {
      throw new Error('SQLite test database URLs must include a file path.');
    }
    return {
      driver: 'sqlite',
      file: path.isAbsolute(file) ? file : path.join(BACKEND_ROOT, file),
    };
  }

  if (scheme === 'postgres' || scheme === 'postgresql') {
    // postgres://user:pass@host:port/database
    const atIndex = rest.lastIndexOf('@');
    const credentials = atIndex === -1 ? '' : rest.slice(0, atIndex);
    const location = atIndex === -1 ? rest : rest.slice(atIndex + 1);

    const [hostPort, database] = location.split('/');
    const [host, port] = hostPort.split(':');
    const [user, password] = credentials.split(':');

    return {
      driver: 'postgres',
      host: host || config.DB_HOST,
      port: port ? parseInt(port, 10) : config.DB_PORT,
      user: user ? decodeURIComponent(user) : config.DB_USER,
      password: password ? decodeURIComponent(password) : config.DB_PASSWORD,
      database: database ? decodeURIComponent(database) : config.DB_NAME,
      ssl: config.DB_SSL_OPTIONS,
    };
  }

  if (scheme === 'mysql' || scheme === 'mysql2') {
    // mysql://user:pass@host:port/database
    const atIndex = rest.lastIndexOf('@');
    const credentials = atIndex === -1 ? '' : rest.slice(0, atIndex);
    const location = atIndex === -1 ? rest : rest.slice(atIndex + 1);

    const [hostPort, database] = location.split('/');
    const [host, port] = hostPort.split(':');
    const [user, password] = credentials.split(':');

    return {
      driver: 'mysql',
      host: host || config.DB_HOST,
      port: port ? parseInt(port, 10) : config.DB_PORT,
      user: user ? decodeURIComponent(user) : config.DB_USER,
      password: password ? decodeURIComponent(password) : config.DB_PASSWORD,
      database: database ? decodeURIComponent(database) : config.DB_NAME,
      ssl: config.DB_SSL ? {} : undefined,
    };
  }

  throw new Error(`Unsupported database URL scheme: ${scheme}`);
};

const nowIso = () => new Date().toISOString();

/** Normalise JS values into something all three engines accept. */
const normalise = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
};

/**
 * Convert a result row from the engine into plain JSON-safe values.
 *
 * PostgreSQL returns `Date` objects for date/time columns while MySQL and
 * SQLite return strings.  Normalising to an ISO string keeps the API response
 * payloads identical regardless of the configured engine.
 */
const normaliseRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Date) {
      row[key] = value.toISOString();
    } else if (Buffer.isBuffer(value)) {
      row[key] = value.toString('utf8');
    } else if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
      // node-postgres returns NUMERIC/BIGINT as a string to avoid precision
      // loss; normalise it to a plain number for the API.
      row[key] = value.toNumber();
    }
  }
  return row;
};

/**
 * Translate the MySQL-flavoured SQL used throughout the models into the
 * dialect of the active driver.
 *
 * The models are written once using backtick-quoted identifiers and `?`
 * placeholders (the MySQL/SQLite style).  PostgreSQL expects double-quoted
 * identifiers and numbered `$1, $2, ...` placeholders, so the conversion
 * happens here, in one place, rather than in every query.
 */
const translateSql = (sql, driver) => {
  if (driver !== 'postgres') return sql;

  const out = sql.replace(/`([^`]*)`/g, '"$1"');

  // Replace `?` placeholders with numbered PostgreSQL placeholders.  A `?`
  // inside a quoted literal is skipped so the conversion stays safe.
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let result = '';
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '?' && !inSingle && !inDouble) {
      index += 1;
      result += `$${index}`;
    } else {
      result += ch;
    }
  }

  // PostgreSQL needs an explicit RETURNING clause to hand back the new id.
  if (/^\s*INSERT\s+INTO/i.test(result) && !/RETURNING/i.test(result)) {
    result += ' RETURNING id';
  }

  return result;
};

class Database {
  constructor() {
    this.settings = parseDatabaseUrl(config.DATABASE_URL);
    this.driver = this.settings.driver;
    this.pool = null;
    this.sqlite = null;
    this.ready = false;
  }


  async init() {
    if (this.ready) return;
    if (this.driver === 'postgres') {
      // eslint-disable-next-line global-require
      const { Pool } = require('pg');
      this.pool = new Pool({
        host: this.settings.host,
        port: this.settings.port,
        user: this.settings.user,
        password: this.settings.password,
        database: this.settings.database,
        ssl: this.settings.ssl,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        // Partner tables live in this schema of the shared database.
        // Service, website and superadmin tables stay in public.
        options: '-c search_path=energy_provider',
      });
      // A pool-level error handler prevents an idle client failure from
      // crashing the process.
      this.pool.on('error', (err) => {
        console.error('Unexpected postgres pool error:', err.message);
      });
    } else if (this.driver === 'mysql') {
      // eslint-disable-next-line global-require
      const mysql = require('mysql2/promise');
      this.pool = mysql.createPool({
        host: this.settings.host,
        port: this.settings.port,
        user: this.settings.user,
        password: this.settings.password,
        database: this.settings.database,
        ssl: this.settings.ssl,
        waitForConnections: true,
        connectionLimit: 10,
        charset: 'utf8mb4_general_ci',
        dateStrings: true,
      });
    } else {
      // eslint-disable-next-line global-require
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('fs');
      fs.mkdirSync(path.dirname(this.settings.file), { recursive: true });
      this.sqlite = new DatabaseSync(this.settings.file);
      this.sqlite.exec('PRAGMA foreign_keys = ON');
    }
    this.ready = true;
    await this.migrate();
  }

  /** Create every table/index declared in schema.js (idempotent). */
  async migrate() {
    // One mobile can hold every partner role. Drop the old single-mobile unique index
    // before the non-unique index is created again.
    if (this.driver !== 'mysql') {
      await this.run('DROP INDEX IF EXISTS idx_users_mobile');
    }
    for (const [tableName, table] of Object.entries(tables)) {
      await this.run(renderTable(this.driver, tableName, table));
      for (const index of table.indexes || []) {
        try {
          await this.run(renderIndex(this.driver, tableName, index));
        } catch (err) {
          // An index that already exists is not an error for our purposes.
          if (!/exists|duplicate/i.test(err.message || '')) throw err;
        }
      }
    }
    const scheduledAtColumn = tables.jobs.columns.scheduled_at;
    if (!await this.hasColumn('jobs', 'scheduled_at')) {
      await this.run(
        `ALTER TABLE ${quote(this.driver, 'jobs')} ADD COLUMN ${quote(this.driver, 'scheduled_at')} ${renderType(this.driver, scheduledAtColumn)}`
      );
    }
    const assignedAtColumn = tables.jobs.columns.assigned_at;
    if (!await this.hasColumn('jobs', 'assigned_at')) {
      await this.run(
        `ALTER TABLE ${quote(this.driver, 'jobs')} ADD COLUMN ${quote(this.driver, 'assigned_at')} ${renderType(this.driver, assignedAtColumn)}`
      );
    }
    const specializationStatusColumn = tables.partner_applications.columns.specialization_status;
    if (!await this.hasColumn('partner_applications', 'specialization_status')) {
      await this.run(
        `ALTER TABLE ${quote(this.driver, 'partner_applications')} ADD COLUMN ${quote(this.driver, 'specialization_status')} ${renderType(this.driver, specializationStatusColumn)} DEFAULT 'unsubmitted'`
      );
      await this.run(
        `UPDATE ${quote(this.driver, 'partner_applications')} SET ${quote(this.driver, 'specialization_status')} = 'approved' WHERE ${quote(this.driver, 'specializations')} IS NOT NULL`
      );
    }
    const userSpecializationStatusColumn = tables.users.columns.specialization_status;
    if (!await this.hasColumn('users', 'specialization_status')) {
      await this.run(
        `ALTER TABLE ${quote(this.driver, 'users')} ADD COLUMN ${quote(this.driver, 'specialization_status')} ${renderType(this.driver, userSpecializationStatusColumn)} DEFAULT 'unsubmitted'`
      );
    }
    for (const [tableName, columnName] of [['users', 'account_group_id'], ['users', 'qualification_details'], ['users', 'specialization_details'], ['users', 'service_area_details']]) {
      if (await this.hasColumn(tableName, columnName)) continue;
      const spec = tables[tableName].columns[columnName];
      await this.run(
        `ALTER TABLE ${quote(this.driver, tableName)} ADD COLUMN ${quote(this.driver, columnName)} ${renderType(this.driver, spec)}`
      );
    }
    const users = await this.query('SELECT id, mobile, role FROM users ORDER BY id');
    const accountIds = new Map();
    for (const account of users) {
      if (!account.role) continue;
      if (!accountIds.has(account.mobile)) accountIds.set(account.mobile, Number(account.id));
      await this.run(
        'UPDATE `users` SET `account_group_id` = ? WHERE `id` = ? AND `account_group_id` IS NULL',
        [accountIds.get(account.mobile), account.id]
      );
    }
  }

  async hasColumn(tableName, columnName) {
    if (this.driver === 'sqlite') {
      const columns = await this.query(`PRAGMA table_info(${quote(this.driver, tableName)})`);
      return columns.some((column) => column.name === columnName);
    }
    const query = this.driver === 'postgres'
      ? 'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?'
      : 'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?';
    const columns = await this.query(query, [tableName, columnName]);
    return columns.length > 0;
  }

  async query(sql, params = []) {
    const values = params.map(normalise);
    if (this.driver === 'postgres') {
      const result = await this.pool.query(translateSql(sql, this.driver), values);
      return result.rows.map(normaliseRow);
    }
    if (this.driver === 'mysql') {
      const [rows] = await this.pool.query(sql, values);
      return rows;
    }
    const statement = this.sqlite.prepare(sql);
    return statement.all(...values);
  }

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows.length ? rows[0] : null;
  }

  async run(sql, params = []) {
    const values = params.map(normalise);
    if (this.driver === 'postgres') {
      const result = await this.pool.query(translateSql(sql, this.driver), values);
      const row = result.rows[0];
      return {
        insertId: row && row.id !== undefined ? Number(row.id) : undefined,
        affectedRows: result.rowCount || 0,
        changedRows: result.rowCount || 0,
      };
    }
    if (this.driver === 'mysql') {
      const [result] = await this.pool.query(sql, values);
      return {
        insertId: result.insertId,
        affectedRows: result.affectedRows,
        changedRows: result.changedRows,
      };
    }
    const statement = this.sqlite.prepare(sql);
    const result = statement.run(...values);
    return {
      insertId: Number(result.lastInsertRowid),
      affectedRows: Number(result.changes),
      changedRows: Number(result.changes),
    };
  }

  /**
   * Run `fn` inside a transaction.  The callback receives a scoped handle with
   * the same query/get/run API.  Any thrown error rolls the transaction back.
   */
  async transaction(fn) {
    if (this.driver === 'postgres') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(this._handleFor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError.message);
        }
        throw err;
      } finally {
        client.release();
      }
    }

    if (this.driver === 'mysql') {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(this._handleFor(connection));
        await connection.commit();
        return result;
      } catch (err) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError.message);
        }
        throw err;
      } finally {
        connection.release();
      }
    }

    // SQLite: the driver is synchronous so a simple BEGIN/COMMIT is enough.
    await this.run('BEGIN');
    try {
      const result = await fn(this);
      await this.run('COMMIT');
      return result;
    } catch (err) {
      try {
        await this.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError.message);
      }
      throw err;
    }
  }

  _handleFor(client) {
    const isPostgres = this.driver === 'postgres';
    const query = async (sql, params = []) => {
      const values = params.map(normalise);
      if (isPostgres) {
        const result = await client.query(translateSql(sql, this.driver), values);
        return result.rows.map(normaliseRow);
      }
      const [rows] = await client.query(sql, values);
      return rows;
    };
    return {
      query,
      get: async (sql, params = []) => {
        const rows = await query(sql, params);
        return rows.length ? rows[0] : null;
      },
      run: async (sql, params = []) => {
        const values = params.map(normalise);
        if (isPostgres) {
          const result = await client.query(translateSql(sql, this.driver), values);
          const row = result.rows[0];
          return {
            insertId: row && row.id !== undefined ? Number(row.id) : undefined,
            affectedRows: result.rowCount || 0,
            changedRows: result.rowCount || 0,
          };
        }
        const [result] = await client.query(sql, values);
        return {
          insertId: result.insertId,
          affectedRows: result.affectedRows,
          changedRows: result.changedRows,
        };
      },
    };
  }

  async close() {
    if (this.driver === 'postgres' && this.pool) {
      await this.pool.end();
      this.pool = null;
    } else if (this.driver === 'mysql' && this.pool) {
      await this.pool.end();
      this.pool = null;
    } else if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
    this.ready = false;
  }

  /** Human readable description of the active connection (no secrets). */
  describe() {
    if (this.driver === 'postgres') {
      return `postgres://${this.settings.user}@${this.settings.host}:${this.settings.port}/${this.settings.database}`;
    }
    if (this.driver === 'mysql') {
      return `mysql://${this.settings.user}@${this.settings.host}:${this.settings.port}/${this.settings.database}`;
    }
    return `sqlite://${path.relative(BACKEND_ROOT, this.settings.file)}`;
  }
}

const db = new Database();

module.exports = { db, parseDatabaseUrl, nowIso, normalise, translateSql };
