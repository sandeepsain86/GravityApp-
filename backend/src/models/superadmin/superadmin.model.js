const { pool } = require('../../config/postgres');

function present(row, withPassword) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    ...(withPassword ? { password: row.password } : {}),
  };
}

async function findByEmail(email, withPassword = false) {
  const { rows } = await pool.query('SELECT * FROM superadmins WHERE email = $1', [email]);
  return present(rows[0], withPassword);
}

async function create({ name, email, password }) {
  const { rows } = await pool.query(
    `INSERT INTO superadmins (name, email, password)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, email, password]
  );
  return present(rows[0], false);
}

module.exports = { findByEmail, create };
