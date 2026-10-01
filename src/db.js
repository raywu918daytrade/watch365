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

// Formula library tables (see src/formulaLibrary.js). Same pattern: created on boot, mysql2 loaded lazily.
const LIBRARY_TABLE = 'watch365_formula_library';
const ALIAS_TABLE = 'watch365_formula_alias';

export async function createFormulaLibraryBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${LIBRARY_TABLE} (
    fingerprint CHAR(64) NOT NULL PRIMARY KEY,
    ast LONGTEXT NOT NULL,
    name VARCHAR(100) NOT NULL,
    summary TEXT NOT NULL,
    warmup_bars INT NOT NULL DEFAULT 0,
    source VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    hit_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${ALIAS_TABLE} (
    alias_norm VARCHAR(255) NOT NULL PRIMARY KEY,
    fingerprint CHAR(64) NOT NULL,
    alias_raw VARCHAR(255) NOT NULL,
    hits INT NOT NULL DEFAULT 0,
    last_used_at DATETIME(3) NULL,
    source VARCHAR(16) NOT NULL,
    INDEX idx_formula_alias_fingerprint (fingerprint)
  )`);
  const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null);
  const at = (value) => (value ? new Date(value) : null);
  return {
    label: `${config.host}/${config.database}`,
    async loadAll() {
      const [formulas] = await pool.query(`SELECT fingerprint, ast, name, summary, warmup_bars, source, status, hit_count, created_at, updated_at FROM ${LIBRARY_TABLE}`);
      const [aliases] = await pool.query(`SELECT alias_norm, fingerprint, alias_raw, hits, last_used_at, source FROM ${ALIAS_TABLE}`);
      return {
        formulas: formulas.map((row) => ({ fingerprint: row.fingerprint, ast: row.ast, name: row.name, summary: row.summary, warmupBars: row.warmup_bars, source: row.source, status: row.status, hitCount: row.hit_count, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
        aliases: aliases.map((row) => ({ aliasNorm: row.alias_norm, fingerprint: row.fingerprint, aliasRaw: row.alias_raw, hits: row.hits, lastUsedAt: iso(row.last_used_at), source: row.source }))
      };
    },
    async upsertFormula(formula) {
      await pool.query(
        `INSERT INTO ${LIBRARY_TABLE} (fingerprint, ast, name, summary, warmup_bars, source, status, hit_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ast = VALUES(ast), name = VALUES(name), summary = VALUES(summary), warmup_bars = VALUES(warmup_bars), source = VALUES(source), status = VALUES(status), hit_count = VALUES(hit_count), updated_at = VALUES(updated_at)`,
        [formula.fingerprint, JSON.stringify(formula.ast), formula.name, formula.summary, formula.warmupBars, formula.source, formula.status, formula.hitCount, at(formula.createdAt), at(formula.updatedAt)]
      );
    },
    async upsertAlias(alias) {
      await pool.query(
        `INSERT INTO ${ALIAS_TABLE} (alias_norm, fingerprint, alias_raw, hits, last_used_at, source) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), alias_raw = VALUES(alias_raw), hits = VALUES(hits), last_used_at = VALUES(last_used_at), source = VALUES(source)`,
        [alias.aliasNorm, alias.fingerprint, alias.aliasRaw, alias.hits, at(alias.lastUsedAt), alias.source]
      );
    },
    async close() { await pool.end(); }
  };
}
