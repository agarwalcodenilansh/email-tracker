const { Pool } = require('pg');
const Database = require('better-sqlite3');

let db;

if (process.env.DATABASE_URL) {
  // ── Cloud: PostgreSQL (Railway) ──
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Wrap pool to match SQLite API so server.js needs no changes
  db = {
    exec: async (sql) => { await pool.query(sql); },
    prepare: (sql) => ({
      run: async (...params) => { await pool.query(sql.replace(/\?/g, (_, i) => `$${++i}`), params); },
      get:  async (...params) => {
        const r = await pool.query(sql.replace(/\?/g, () => `$${[...arguments].indexOf(...params)+1}`), params);
        return r.rows[0];
      },
      all:  async (...params) => {
        const r = await pool.query(sql, params);
        return r.rows;
      },
    }),
    _pool: pool
  };
} else {
  // ── Local: SQLite ──
  db = new Database('tracker.db');
}

module.exports = db;