// Event log: the foundation of the admin dashboard. Every user-facing action the server sees is recorded as
// { ts, visitor, type, payload } and later counted / listed by the admin API. Recording is fire-and-forget:
// a failure is logged and never fails the request that produced it.
//
// Storage follows db.js: with DB_HOST the rows go to watch365_events (indexes on (type, ts) and (visitor, ts));
// without a database they are appended to data/events.jsonl and the last MAX_MEMORY lines are kept in memory,
// which is what query / aggregate read in that mode.
//
// Privacy: visitor is an anonymous random cookie id (see visitor.js), never an account or an IP; page views
// carry only a coarse browser / OS classification, never the full user agent.

import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

export const EVENT_TYPES = Object.freeze(['page_view', 'parse', 'template_instantiate', 'monitor_configure', 'monitor_start', 'monitor_stop', 'monitor_run', 'backtest', 'indicator_request', 'unknown_indicator', 'vet_blocked', 'admin_login', 'admin_status_change']);
const MAX_MEMORY = 50_000;
const MAX_PAYLOAD_CHARS = 4000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export class EventStore {
  constructor(filePath, { backend = null, log = console, maxMemory = MAX_MEMORY } = {}) {
    this.filePath = filePath; this.backend = backend; this.log = log; this.maxMemory = maxMemory;
    this.items = []; this.nextId = 1; this.queue = Promise.resolve();
  }

  async load() {
    if (this.backend) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    const lines = [];
    try {
      const reader = createInterface({ input: createReadStream(this.filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of reader) { if (!line.trim()) continue; lines.push(line); if (lines.length > this.maxMemory) lines.shift(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.items = [];
    for (const line of lines) { try { const row = JSON.parse(line); if (validRow(row)) this.items.push(row); } catch { /* a torn last line after a crash is skipped */ } }
    this.nextId = this.items.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    return this;
  }

  // Never rejects. Returns the recorded row (or null when the input was invalid).
  record(type, payload = null, { visitor = null, ts = new Date() } = {}) {
    if (typeof type !== 'string' || !/^[a-z_]{2,48}$/.test(type)) { this.log.warn?.(`events: dropping event with invalid type ${JSON.stringify(type)}`); return Promise.resolve(null); }
    const row = { id: 0, ts: new Date(ts).toISOString(), visitor: typeof visitor === 'string' && visitor ? visitor.slice(0, 64) : null, type, payload: boundedPayload(payload) };
    const operation = this.queue.then(async () => {
      if (this.backend) { await this.backend.insert(row); return row; }
      row.id = this.nextId++;
      this.items.push(row); if (this.items.length > this.maxMemory) this.items.splice(0, this.items.length - this.maxMemory);
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
      return row;
    }).catch((error) => { this.log.error?.(`events: record ${type} failed`, error.code || error.message); return null; });
    this.queue = operation;
    return operation;
  }
  // Resolves once every record() issued so far has been written (tests and shutdown).
  flush() { return this.queue; }

  async query({ type = null, types = null, from = null, to = null, visitor = null, limit = 200, offset = 0 } = {}) {
    limit = clampInt(limit, 1, 1000, 200); offset = clampInt(offset, 0, 1e9, 0);
    if (this.backend) return this.backend.query({ type, types, from, to, visitor }, { limit, offset });
    const matched = this.items.filter(matcher({ type, types, from, to, visitor })).reverse();
    return { items: matched.slice(offset, offset + limit).map((row) => structuredClone(row)), total: matched.length };
  }

  // [{ key, count }]. groupBy: 'day' (Asia/Taipei calendar day, ascending), 'visitor' or 'payload.<key>' (both by
  // count descending). A payload value that is an array counts once per element (file mode only; the SQL path
  // groups on the scalar).
  async aggregate({ type = null, types = null, from = null, to = null, visitor = null, groupBy = 'day' } = {}) {
    if (this.backend) return this.backend.aggregate({ type, types, from, to, visitor }, groupBy);
    const keyOf = groupKey(groupBy);
    const counts = new Map();
    for (const row of this.items) {
      if (!matcher({ type, types, from, to, visitor })(row)) continue;
      for (const key of keyOf(row)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const result = [...counts].map(([key, count]) => ({ key, count }));
    return groupBy === 'day' ? result.sort((a, b) => a.key.localeCompare(b.key)) : result.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  async visitorRange(visitor) {
    if (!visitor) return null;
    if (this.backend) return this.backend.visitorRange(visitor);
    let first = null, last = null;
    for (const row of this.items) if (row.visitor === visitor) { if (!first || row.ts < first) first = row.ts; if (!last || row.ts > last) last = row.ts; }
    return first ? { firstSeen: first, lastSeen: last } : null;
  }

  // [{ visitor, firstSeen, lastSeen, counts:{ type: n } }] newest activity first.
  async visitors({ from = null, to = null, limit = 100 } = {}) {
    limit = clampInt(limit, 1, 1000, 100);
    if (this.backend) return this.backend.visitors({ from, to }, { limit });
    const byVisitor = new Map();
    for (const row of this.items) {
      if (!row.visitor || !matcher({ from, to })(row)) continue;
      const entry = byVisitor.get(row.visitor) || { visitor: row.visitor, firstSeen: row.ts, lastSeen: row.ts, counts: {} };
      if (row.ts < entry.firstSeen) entry.firstSeen = row.ts; if (row.ts > entry.lastSeen) entry.lastSeen = row.ts;
      entry.counts[row.type] = (entry.counts[row.type] || 0) + 1; byVisitor.set(row.visitor, entry);
    }
    return [...byVisitor.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit);
  }
}

export function taipeiDay(iso) { return new Date(new Date(iso).getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10); }

function groupKey(groupBy) {
  if (groupBy === 'day') return (row) => [taipeiDay(row.ts)];
  if (groupBy === 'visitor') return (row) => (row.visitor ? [row.visitor] : []);
  if (typeof groupBy === 'string' && groupBy.startsWith('payload.')) {
    const key = groupBy.slice('payload.'.length);
    if (!/^[A-Za-z0-9_]{1,48}$/.test(key)) throw Object.assign(new Error('EVENT_GROUP_INVALID'), { code: 'EVENT_GROUP_INVALID', statusCode: 400 });
    return (row) => { const value = row.payload?.[key]; if (value == null) return []; return (Array.isArray(value) ? value : [value]).filter((item) => item != null && typeof item !== 'object').map(String); };
  }
  throw Object.assign(new Error('EVENT_GROUP_INVALID'), { code: 'EVENT_GROUP_INVALID', statusCode: 400 });
}
function matcher({ type = null, types = null, from = null, to = null, visitor = null }) {
  const fromIso = from ? new Date(from).toISOString() : null, toIso = to ? new Date(to).toISOString() : null;
  return (row) => (!type || row.type === type) && (!types || types.includes(row.type)) && (!visitor || row.visitor === visitor) && (!fromIso || row.ts >= fromIso) && (!toIso || row.ts < toIso);
}
function boundedPayload(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'object') return { value: payload };
  const text = JSON.stringify(payload);
  if (text.length <= MAX_PAYLOAD_CHARS) return JSON.parse(text);
  return { truncated: true, preview: text.slice(0, MAX_PAYLOAD_CHARS) };
}
function validRow(row) { return row && typeof row === 'object' && Number.isInteger(row.id) && typeof row.ts === 'string' && typeof row.type === 'string'; }
function clampInt(value, min, max, fallback) { const number = Number(value); if (!Number.isFinite(number)) return fallback; return Math.min(max, Math.max(min, Math.trunc(number))); }
