const { pool } = require('../../config/postgres');

function isUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id));
}

function presentProvider(row) {
  return {
    _id: row.id,
    id: row.id,
    app: 'energy_provider',
    name: row.full_name || row.mobile,
    email: row.email,
    phone: row.mobile,
    role: row.role,
    status: row.status,
    isBlocked: ['suspended', 'rejected', 'blocked'].includes(row.status),
  };
}

function presentService(row) {
  return {
    _id: row.id,
    id: row.id,
    app: 'energy_service',
    name: row.name || row.phone,
    email: row.email,
    phone: row.phone,
    role: row.role || 'user',
    status: row.status,
    isBlocked: row.status === 'suspended',
  };
}

async function list(app) {
  const users = [];
  if (!app || app === 'energy_provider') {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, mobile, role, status
       FROM energy_provider.users
       ORDER BY id DESC
       LIMIT 200`
    );
    users.push(...rows.map(presentProvider));
  }
  if (!app || app === 'energy_service') {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       ORDER BY u.created_at DESC
       LIMIT 200`
    );
    users.push(...rows.map(presentService));
  }
  return users;
}

async function counts() {
  const provider = await pool.query('SELECT COUNT(*)::int AS n FROM energy_provider.users');
  const service = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  const website = await pool.query('SELECT COUNT(*)::int AS n FROM website_contacts');
  return {
    energy_provider: provider.rows[0].n,
    energy_service: service.rows[0].n,
    energy_website: website.rows[0].n,
  };
}

async function setBlocked(id, blocked) {
  if (isUuid(id)) {
    const status = blocked ? 'suspended' : 'active';
    const { rows } = await pool.query(
      `UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name, email, phone, status`,
      [id, status]
    );
    return rows[0] ? presentService(rows[0]) : null;
  }
  const status = blocked ? 'suspended' : 'approved';
  const { rows } = await pool.query(
    `UPDATE energy_provider.users SET status = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, full_name, email, mobile, role, status`,
    [id, status]
  );
  return rows[0] ? presentProvider(rows[0]) : null;
}

async function remove(id) {
  if (isUuid(id)) {
    const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    'DELETE FROM energy_provider.users WHERE id = $1 RETURNING id',
    [id]
  );
  return rows[0] || null;
}

module.exports = { list, counts, setBlocked, remove };
