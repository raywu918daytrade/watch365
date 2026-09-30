// Optional MySQL-compatible document backend (TiDB Cloud in production).
// When DB_HOST is unset the app keeps using the local JSON files, so local dev needs no database.
// Each store (monitor state, indicator requests) is one JSON document keyed by name.

const TABLE = 'watch365_documents';

export function dbConfigFromEnv(env = process.env) {
  if (!env.DB_HOST) return null;
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 4000),
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    // TiDB Cloud Serverless only accepts TLS connections.
    ssl: env.DB_SSL === 'false' ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionLimit: 4,
    enableKeepAlive: true
  };
}

export async function createDocumentBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    doc_key VARCHAR(64) NOT NULL PRIMARY KEY,
    body LONGTEXT NOT NULL,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  )`);
  return {
    label: `${config.host}/${config.database}`,
    async read(key) {
      const [rows] = await pool.query(`SELECT body FROM ${TABLE} WHERE doc_key = ?`, [key]);
      return rows.length ? JSON.parse(rows[0].body) : null;
    },
    async write(key, value) {
      await pool.query(
        `INSERT INTO ${TABLE} (doc_key, body) VALUES (?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body)`,
        [key, JSON.stringify(value)]
      );
    },
    async close() { await pool.end(); }
  };
}
