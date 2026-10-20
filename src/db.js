// Optional MySQL-compatible document backend (TiDB Cloud in production).
// When DB_HOST is unset the app keeps using the local JSON files, so local dev needs no database.
// STORAGE=files forces the JSON files even with DB_HOST set (production on a Railway volume since 2026-10-20, after
// the TiDB free quota ran out; the DB_* settings are kept so the database can be switched back on).
// Each store (monitor state, indicator requests) is one JSON document keyed by name.

const TABLE = 'watch365_documents';

export function dbConfigFromEnv(env = process.env) {
  if (!env.DB_HOST || env.STORAGE === 'files') return null;
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

// Event log and unknown-indicator tables (see src/events.js, src/indicatorLookup.js). Same pattern again:
// created on boot, mysql2 loaded lazily, JSON files when DB_HOST is unset.
const EVENTS_TABLE = 'watch365_events';
const UNKNOWN_TABLE = 'watch365_unknown_indicators';

export async function createEventBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ts DATETIME(3) NOT NULL,
    visitor VARCHAR(64) NULL,
    type VARCHAR(48) NOT NULL,
    payload LONGTEXT NULL,
    INDEX idx_events_type_ts (type, ts),
    INDEX idx_events_visitor_ts (visitor, ts)
  )`);
  const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null);
  const parse = (value) => { if (value == null) return null; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return null; } };
  // Shared WHERE builder: every filter the store supports maps onto the two indexes above.
  const where = ({ type, from, to, visitor, types } = {}) => {
    const clauses = [], params = [];
    if (type) { clauses.push('type = ?'); params.push(type); }
    if (Array.isArray(types) && types.length) { clauses.push(`type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    if (visitor) { clauses.push('visitor = ?'); params.push(visitor); }
    if (from) { clauses.push('ts >= ?'); params.push(new Date(from)); }
    if (to) { clauses.push('ts < ?'); params.push(new Date(to)); }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  };
  const row = (item) => ({ id: Number(item.id), ts: iso(item.ts), visitor: item.visitor, type: item.type, payload: parse(item.payload) });
  return {
    label: `${config.host}/${config.database}`,
    async insert(event) {
      await pool.query(`INSERT INTO ${EVENTS_TABLE} (ts, visitor, type, payload) VALUES (?, ?, ?, ?)`, [new Date(event.ts), event.visitor, event.type, event.payload == null ? null : JSON.stringify(event.payload)]);
    },
    async query(filter, { limit, offset }) {
      const { sql, params } = where(filter);
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${EVENTS_TABLE} ${sql}`, params);
      const [rows] = await pool.query(`SELECT id, ts, visitor, type, payload FROM ${EVENTS_TABLE} ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return { items: rows.map(row), total: Number(total) };
    },
    // groupBy: 'day' → Taipei calendar day, 'visitor', or 'payload.<key>' (a top-level JSON key).
    async aggregate(filter, groupBy) {
      const { sql, params } = where(filter);
      let expression;
      if (groupBy === 'day') expression = `DATE_FORMAT(CONVERT_TZ(ts, '+00:00', '+08:00'), '%Y-%m-%d')`;
      else if (groupBy === 'visitor') expression = 'visitor';
      else if (groupBy.startsWith('payload.')) { const key = groupBy.slice('payload.'.length); if (!/^[A-Za-z0-9_]{1,48}$/.test(key)) throw Object.assign(new Error('EVENT_GROUP_INVALID'), { code: 'EVENT_GROUP_INVALID' }); expression = `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${key}'))`; }
      else throw Object.assign(new Error('EVENT_GROUP_INVALID'), { code: 'EVENT_GROUP_INVALID' });
      const [rows] = await pool.query(`SELECT ${expression} AS k, COUNT(*) AS c FROM ${EVENTS_TABLE} ${sql} GROUP BY k ORDER BY ${groupBy === 'day' ? 'k ASC' : 'c DESC, k ASC'} LIMIT 1000`, params);
      return rows.filter((item) => item.k != null).map((item) => ({ key: String(item.k), count: Number(item.c) }));
    },
    async visitorRange(visitor) {
      const [rows] = await pool.query(`SELECT MIN(ts) AS first_seen, MAX(ts) AS last_seen, COUNT(*) AS total FROM ${EVENTS_TABLE} WHERE visitor = ?`, [visitor]);
      return rows[0]?.total ? { firstSeen: iso(rows[0].first_seen), lastSeen: iso(rows[0].last_seen) } : null;
    },
    // Per-visitor summary over a window: first/last seen and one count per type.
    async visitors(filter, { limit }) {
      const { sql, params } = where(filter);
      const [rows] = await pool.query(`SELECT visitor, MIN(ts) AS first_seen, MAX(ts) AS last_seen, type, COUNT(*) AS c FROM ${EVENTS_TABLE} ${sql ? `${sql} AND` : 'WHERE'} visitor IS NOT NULL GROUP BY visitor, type`, params);
      const byVisitor = new Map();
      for (const item of rows) {
        const entry = byVisitor.get(item.visitor) || { visitor: item.visitor, firstSeen: iso(item.first_seen), lastSeen: iso(item.last_seen), counts: {} };
        if (iso(item.first_seen) < entry.firstSeen) entry.firstSeen = iso(item.first_seen);
        if (iso(item.last_seen) > entry.lastSeen) entry.lastSeen = iso(item.last_seen);
        entry.counts[item.type] = Number(item.c); byVisitor.set(item.visitor, entry);
      }
      return [...byVisitor.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit);
    },
    async close() { await pool.end(); }
  };
}

export async function createUnknownIndicatorBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${UNKNOWN_TABLE} (
    norm VARCHAR(255) NOT NULL PRIMARY KEY,
    text VARCHAR(500) NOT NULL,
    candidates LONGTEXT NULL,
    count INT NOT NULL DEFAULT 1,
    first_seen DATETIME(3) NOT NULL,
    last_seen DATETIME(3) NOT NULL
  )`);
  const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null);
  return {
    label: `${config.host}/${config.database}`,
    async loadAll() {
      const [rows] = await pool.query(`SELECT norm, text, candidates, count, first_seen, last_seen FROM ${UNKNOWN_TABLE}`);
      return rows.map((item) => ({ norm: item.norm, text: item.text, candidates: typeof item.candidates === 'string' ? JSON.parse(item.candidates) : item.candidates || [], count: Number(item.count), firstSeen: iso(item.first_seen), lastSeen: iso(item.last_seen) }));
    },
    async upsert(item) {
      await pool.query(`INSERT INTO ${UNKNOWN_TABLE} (norm, text, candidates, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE text = VALUES(text), candidates = VALUES(candidates), count = VALUES(count), last_seen = VALUES(last_seen)`,
      [item.norm, item.text, JSON.stringify(item.candidates), item.count, new Date(item.firstSeen), new Date(item.lastSeen)]);
    },
    async close() { await pool.end(); }
  };
}

// Shared condition state (src/conditionState.js): one row per (condition, symbol), upserted only when it changed,
// plus the condition definitions so the back office can show what each key means.
const CONDITION_STATE_TABLE = 'watch365_condition_state';
const CONDITION_TABLE = 'watch365_conditions';

export async function createConditionStateBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${CONDITION_TABLE} (
    condition_key CHAR(64) NOT NULL PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    label VARCHAR(500) NULL,
    ast LONGTEXT NOT NULL,
    first_seen TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${CONDITION_STATE_TABLE} (
    condition_key CHAR(64) NOT NULL,
    symbol VARCHAR(8) NOT NULL,
    trading_date CHAR(10) NOT NULL,
    value TINYINT NULL,
    since_bar VARCHAR(32) NULL,
    last_bar VARCHAR(32) NOT NULL,
    flips_today INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (condition_key, symbol),
    INDEX idx_condition_state_date (trading_date)
  )`);
  const chunks = (items, size) => { const out = []; for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size)); return out; };
  return {
    label: `${config.host}/${config.database}`,
    async loadStates({ since }) {
      await pool.query(`DELETE FROM ${CONDITION_STATE_TABLE} WHERE trading_date < ?`, [since]);
      const [rows] = await pool.query(`SELECT condition_key, symbol, trading_date, value, since_bar, last_bar, flips_today FROM ${CONDITION_STATE_TABLE}`);
      return rows.map((row) => ({ conditionKey: row.condition_key, symbol: row.symbol, tradingDate: row.trading_date, value: row.value == null ? null : Boolean(row.value), since: row.since_bar, lastBar: row.last_bar, flipsToday: Number(row.flips_today) }));
    },
    async upsertStates(states) {
      for (const batch of chunks(states, 500)) {
        await pool.query(
          `INSERT INTO ${CONDITION_STATE_TABLE} (condition_key, symbol, trading_date, value, since_bar, last_bar, flips_today) VALUES ?
           ON DUPLICATE KEY UPDATE trading_date = VALUES(trading_date), value = VALUES(value), since_bar = VALUES(since_bar), last_bar = VALUES(last_bar), flips_today = VALUES(flips_today)`,
          [batch.map((state) => [state.conditionKey, state.symbol, state.tradingDate, state.value == null ? null : state.value ? 1 : 0, state.since, state.lastBar, state.flipsToday])]
        );
      }
    },
    async upsertDefinitions(definitions) {
      await pool.query(
        `INSERT INTO ${CONDITION_TABLE} (condition_key, kind, label, ast) VALUES ? ON DUPLICATE KEY UPDATE kind = VALUES(kind), label = VALUES(label), last_seen = CURRENT_TIMESTAMP(3)`,
        [definitions.map((item) => [item.key, item.kind, item.label ? String(item.label).slice(0, 500) : null, JSON.stringify(item.ast)])]
      );
    },
    async close() { await pool.end(); }
  };
}

// Per-rule, per-stock state (src/ruleState.js): idle / triggered / cooldown, upserted only when it changed.
const RULE_STATE_TABLE = 'watch365_rule_state';

export async function createRuleStateBackend(config) {
  if (!config) return null;
  const { createPool } = await import('mysql2/promise');
  const pool = createPool(config);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${RULE_STATE_TABLE} (
    rule_id VARCHAR(255) NOT NULL,
    symbol VARCHAR(8) NOT NULL,
    trading_date CHAR(10) NOT NULL,
    state VARCHAR(16) NOT NULL,
    since_bar VARCHAR(32) NULL,
    last_bar VARCHAR(32) NOT NULL,
    false_bars INT NOT NULL DEFAULT 0,
    triggers_today INT NOT NULL DEFAULT 0,
    suppressed_today INT NOT NULL DEFAULT 0,
    last_trigger_bar VARCHAR(32) NULL,
    baseline TINYINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (rule_id, symbol),
    INDEX idx_rule_state_date (trading_date)
  )`);
  return {
    label: `${config.host}/${config.database}`,
    async loadStates({ since }) {
      await pool.query(`DELETE FROM ${RULE_STATE_TABLE} WHERE trading_date < ?`, [since]);
      const [rows] = await pool.query(`SELECT rule_id, symbol, trading_date, state, since_bar, last_bar, false_bars, triggers_today, suppressed_today, last_trigger_bar, baseline FROM ${RULE_STATE_TABLE}`);
      return rows.map((row) => ({ ruleId: row.rule_id, symbol: row.symbol, tradingDate: row.trading_date, state: row.state, since: row.since_bar, lastBar: row.last_bar, falseBars: Number(row.false_bars), triggersToday: Number(row.triggers_today), suppressedToday: Number(row.suppressed_today), lastTriggerBar: row.last_trigger_bar, baseline: Boolean(row.baseline) }));
    },
    async upsertStates(states) {
      for (let index = 0; index < states.length; index += 500) {
        const batch = states.slice(index, index + 500);
        await pool.query(
          `INSERT INTO ${RULE_STATE_TABLE} (rule_id, symbol, trading_date, state, since_bar, last_bar, false_bars, triggers_today, suppressed_today, last_trigger_bar, baseline) VALUES ?
           ON DUPLICATE KEY UPDATE trading_date = VALUES(trading_date), state = VALUES(state), since_bar = VALUES(since_bar), last_bar = VALUES(last_bar), false_bars = VALUES(false_bars), triggers_today = VALUES(triggers_today), suppressed_today = VALUES(suppressed_today), last_trigger_bar = VALUES(last_trigger_bar), baseline = VALUES(baseline)`,
          [batch.map((state) => [state.ruleId, state.symbol, state.tradingDate, state.state, state.since, state.lastBar, state.falseBars, state.triggersToday, state.suppressedToday, state.lastTriggerBar, state.baseline ? 1 : 0])]
        );
      }
    },
    async close() { await pool.end(); }
  };
}
