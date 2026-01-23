const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
});

async function initDb() {
  await pool.query(`
    create table if not exists licenses (
      id serial primary key,
      license_key text unique not null,
      is_active boolean not null default true,
      created_at timestamp not null default now()
    );
  `);

  await pool.query(`
    create table if not exists signals (
      id serial primary key,
      license_key text not null,
      payload jsonb not null,
      created_at timestamp not null default now()
    );
  `);
}

module.exports = { pool, initDb };
