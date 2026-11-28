const { Pool } = require('pg');
const { getDatabaseConfig } = require('./shared');

const pool = new Pool({
  ...getDatabaseConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL idle-client error:', error.code || error.name || 'unknown');
});

async function connectDatabase() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

module.exports = { pool, connectDatabase };
