import { config } from './config.js';

let pool;
if (config.dbDriver === 'neon') {
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const { default: ws } = await import('ws');
  neonConfig.webSocketConstructor = ws;
  pool = new Pool({ connectionString: config.databaseUrl });
} else {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (compteurs)
  pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
}

export const db = {
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => (await pool.query(text, params)).rows[0] || null,
  many: async (text, params) => (await pool.query(text, params)).rows,
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = {
        query: (a, b) => client.query(a, b),
        one: async (a, b) => (await client.query(a, b)).rows[0] || null,
        many: async (a, b) => (await client.query(a, b)).rows,
      };
      const r = await fn(t);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
  end: () => pool.end(),
};
