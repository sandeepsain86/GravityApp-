const { Client } = require('pg');
const { getDatabaseConfig } = require('./shared');

function quoteDatabaseName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('DB_NAME contains unsupported characters.');
  }
  return `"${name}"`;
}

async function ensureUnifiedDatabase() {
  const database = getDatabaseConfig();
  const admin = new Client({ ...database, database: 'postgres' });
  await admin.connect();
  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database.database],
    );
    if (!existing.rowCount) {
      await admin.query(`CREATE DATABASE ${quoteDatabaseName(database.database)}`);
      console.log(`Created database ${database.database}`);
    }
  } finally {
    await admin.end();
  }

  const app = new Client(database);
  await app.connect();
  try {
    await app.query('CREATE SCHEMA IF NOT EXISTS energy_provider');
    await app.query(`
      CREATE TABLE IF NOT EXISTS website_contacts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        subject TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await app.query(`
      CREATE TABLE IF NOT EXISTS superadmins (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'superadmin',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } finally {
    await app.end();
  }
}

module.exports = { ensureUnifiedDatabase };
