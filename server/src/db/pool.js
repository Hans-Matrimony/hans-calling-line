import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (see server/.env.example)');

export const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127[.]0[.]0[.]1/.test(url) ? false : { rejectUnauthorized: false },
});

export const q = (text, params) => pool.query(text, params);
