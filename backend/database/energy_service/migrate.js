const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { getDatabaseConfig } = require('../../src/config/shared');

async function ensureDatabase(database) {
  const dbName = database.database;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
    throw new Error('DB_NAME contains unsupported characters.');
  }

  const adminPool = new Pool({
    ...database,
    database: 'postgres',
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    const existing = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (existing.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function migrate() {
  const database = getDatabaseConfig();
  await ensureDatabase(database);
  const pool = new Pool({
    ...database,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => /^\d{3}_.+\.sql$/.test(file))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      const already = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        [file],
      );
      if (already.rowCount > 0) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await pool.query('BEGIN');
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        appliedCount += 1;
        console.log(`Applied ${file}`);
      } catch (err) {
        try {
          await pool.query('ROLLBACK');
        } catch (_rollbackError) {
          // Surface the original migration error.
        }
        throw err;
      }
    }

    if (appliedCount > 0) console.log('Database schema is ready');
  } finally {
    await pool.end();
  }
}

function safeError(err) {
  const message = err && err.message ? err.message : 'Migration failed';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database-url]');
}

if (require.main === module) {
  migrate().catch((err) => {
    const code = err && err.code ? ` (${err.code})` : '';
    console.error(`Migration failed${code}: ${safeError(err)}`);
    process.exit(1);
  });
}

module.exports = { migrate };
