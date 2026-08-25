// Postgres-backed database access via Netlify Database (native driver).
// Replaces the old better-sqlite3 synchronous client. All queries here are
// async; callers in src/*.js were converted to async/await accordingly.
const { getDatabase } = require('@netlify/database');

let _db;
function db() {
  if (!_db) _db = getDatabase();
  return _db;
}

// Tagged-template helper that returns rows (array of plain objects).
async function sql(strings, ...values) {
  const res = await db().sql(strings, ...values);
  // native driver returns { rows: [], ... } for SELECTs
  return Array.isArray(res) ? res : (res.rows || []);
}

// Raw SQL with explicit params ($1, $2, ...). Use when the SQL string is built
// dynamically (e.g. conditional WHERE clauses / sort orders) and can't be a
// static tagged template.
async function query(text, params = []) {
  const client = await db().pool.connect();
  try {
    const r = await client.query(text, params);
    return r.rows;
  } finally {
    client.release();
  }
}

// Returns the first row or undefined.
async function sqlOne(strings, ...values) {
  const rows = await sql(strings, ...values);
  return rows[0];
}

// Postgres uses SERIAL for auto-increment; lastInsertRowid isn't available on
// the driver result object, so INSERT...RETURNING id is used by callers.
async function insertReturning(strings, ...values) {
  const res = await db().sql(strings, ...values);
  const rows = Array.isArray(res) ? res : (res.rows || []);
  return rows[0];
}

// Run a transaction body. The Netlify database driver exposes a connection
// pool via db.pool; we use a single client for BEGIN/COMMIT/ROLLBACK.
async function tx(fn) {
  const client = await db().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (text, params) => client.query(text, params).then(r => r.rows),
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { sql, sqlOne, insertReturning, tx, query };
