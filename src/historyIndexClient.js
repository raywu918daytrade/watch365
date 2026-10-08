// Parent side of the 7-day condition index (historyIndexWorker.js). Keeps one long-lived worker, restarts it when it
// dies (re-sending the stock list and every condition it had been given), refreshes today's bars on a timer during
// the session, and turns requests into promises.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 120_000;

export class HistoryIndexClient {
  constructor({ getSymbols, heapMb = 640, refreshMs = 3 * 60_000, log = console, forkImpl = fork } = {}) {
    this.getSymbols = getSymbols;
    this.heapMb = heapMb;
    this.refreshMs = refreshMs;
    this.log = log;
    this.forkImpl = forkImpl;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.conditions = new Map();   // every condition ever sent, replayed after a restart
    this.timer = null;
    this.restarts = 0;
  }

  async start() {
    await this.#spawn();
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, this.refreshMs);
    this.timer.unref?.();
  }

  async refresh() {
    if (!inSessionWindow()) return;
    const child = await this.#ensureChild();
    child.send({ type:'refresh', symbols:await this.#symbols() });
  }

  // Prewarm: compute these conditions now (the indicator list), so the first picks are instant.
  // Waits for the initial load (up to 15 minutes), unlike queries which answer 'loading' right away.
  ensure(conditions) { this.#remember(conditions); return this.#request({ type:'ensure', conditions }, 15 * 60_000); }

  // items: [{ key, ast }] for filters and candidates; returns the HistoryIndex.query result, or { loading:true, … }.
  query({ filters = [], candidates = [], symbols = null, events = true }) {
    const conditions = [...filters, ...candidates];
    this.#remember(conditions);
    return this.#request({ type:'query', conditions, filters:filters.map((item) => item.key), candidates:candidates.map((item) => item.key), symbols, events }).then(async (result) => {
      // A failed initial load (HF down, …) is retried by the next request rather than staying failed.
      if (result?.loading && result.status === 'failed' && this.child) this.child.send({ type:'load', symbols:await this.#symbols() });
      return result;
    });
  }
  known(key) { return this.conditions.get(key) ?? null; }
  // One candlestick example where all these filters hold ([{ key, ast }]); { example:null } when none was found.
  example(filters) { this.#remember(filters); return this.#request({ type:'example', conditions:filters, filters }); }

  status() { return this.#request({ type:'status' }); }

  stop() { clearInterval(this.timer); this.child?.kill(); this.child = null; }

  #remember(conditions) { for (const condition of conditions) if (!this.conditions.has(condition.key)) this.conditions.set(condition.key, condition); }
  async #symbols() { try { return await this.getSymbols(); } catch (error) { this.log.error?.('history-index: symbols unavailable', error.code || error.message); return []; } }

  async #ensureChild() { if (!this.child) await this.#spawn(); return this.child; }

  async #spawn() {
    const child = this.forkImpl(fileURLToPath(new URL('./historyIndexWorker.js', import.meta.url)), [], { execArgv:[`--max-old-space-size=${this.heapMb}`], stdio:['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = child;
    child.on('message', (message) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.type === 'error') request.reject(Object.assign(new Error(message.message || message.code), { code:message.code, statusCode:message.code === 'HISTORY_INDEX_CONDITION_MISSING' ? 409 : 500 }));
      else request.resolve(message.result);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      for (const [id, request] of this.pending) { clearTimeout(request.timer); request.reject(Object.assign(new Error('history index worker exited'), { code:'HISTORY_INDEX_UNAVAILABLE', statusCode:503 })); this.pending.delete(id); }
      this.restarts += 1;
      this.log.error?.(`history-index: worker exited (${signal || code}); it restarts on the next request`);
    });
    child.send({ type:'load', symbols:await this.#symbols() });
    if (this.conditions.size) child.send({ type:'ensure', id:0, conditions:[...this.conditions.values()] });
  }

  async #request(message, timeoutMs = REQUEST_TIMEOUT_MS) {
    const child = await this.#ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('history index timeout'), { code:'HISTORY_INDEX_TIMEOUT', statusCode:504 })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ ...message, id });
    });
  }
}

// Weekdays 08:55–13:45 Taipei: today's file is changing. (A new trading day is picked up by the first refresh.)
export function inSessionWindow(now = new Date()) {
  const taipei = new Date(now.getTime() + 8 * 3_600_000);
  const weekday = taipei.getUTCDay(), minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minutes >= 8 * 60 + 55 && minutes <= 13 * 60 + 45;
}
