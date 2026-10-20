// Per-person monitors. Owner decision (2026-10-20): no login, because a sign-up step makes people leave. Each browser
// (w365v visitor cookie) has its own monitor, and a LINE binding is the identity: linking the same LINE account from
// another browser joins that browser to the same person, so the monitor follows the LINE account.
//
//   owner     = the visitor id of the browser whose monitor it is. Other browsers joined by LINE are mapped to it in
//               the shared store (state.accounts.owners[visitor] = owner); a visitor not in that map is its own owner.
//   monitor   = one JsonStore per owner (data/monitors/<owner>.json, or document key monitor:<owner> with a database).
//               A store is kept in memory once it has been written; a visitor that only looks gets a temporary store
//               that is written (and kept) on its first update, so page views never create files.

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './storage.js';

const OWNER_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_TRANSIENT = 500;
const INDEX_KEY = 'monitor-index';

export class MonitorStores {
  constructor({ dir, shared, backend = null, log = console }) {
    this.dir = dir; this.shared = shared; this.backend = backend; this.log = log;
    this.stores = new Map();      // owner → JsonStore (written at least once)
    this.transient = new Map();   // owner → JsonStore not written yet
  }

  async load() {
    if (!this.backend) await mkdir(this.dir, { recursive: true });
    const owners = this.backend ? (await this.backend.read(INDEX_KEY))?.owners || [] : (await readdir(this.dir).catch(() => [])).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    for (const owner of owners.filter((item) => OWNER_ID.test(item))) {
      const store = this.#create(owner);
      await store.load();
      this.stores.set(owner, store);
    }
    return this;
  }

  ownerOf(visitor) { return this.shared.getState().accounts?.owners?.[visitor] || visitor; }
  has(owner) { return this.stores.has(owner); }
  // [owner, store] of every written monitor.
  all() { return [...this.stores]; }

  get(owner) {
    if (!OWNER_ID.test(String(owner))) throw Object.assign(new Error('VISITOR_INVALID'), { code: 'VISITOR_INVALID', statusCode: 400 });
    const existing = this.stores.get(owner) || this.transient.get(owner);
    if (existing) return existing;
    const store = this.#create(owner);
    this.transient.set(owner, store);
    if (this.transient.size > MAX_TRANSIENT) this.transient.delete(this.transient.keys().next().value);
    return store;
  }

  // Joins `visitor` (and every browser already joined to it) with `owner`, after the same LINE account was linked from
  // both. One monitor is kept: the one set up most recently, so a person who just set up a monitor on a new browser
  // keeps it, and a new browser with nothing set up gets the earlier monitor back. Returns { owner, recovered }:
  // recovered is true when this browser now shows a monitor it did not have before.
  async join(visitor, owner) {
    const mine = this.ownerOf(visitor), theirs = this.ownerOf(owner);
    if (mine === theirs) return { owner: mine, recovered: false };
    const configuredAt = (id) => { const task = this.stores.get(id)?.getState().settings.monitorTask; return task?.onboardingCompleted ? Date.parse(task.completedAt) || 1 : 0; };
    const keep = configuredAt(mine) > configuredAt(theirs) ? mine : theirs, drop = keep === mine ? theirs : mine;
    await this.shared.update((state) => {
      const owners = { ...(state.accounts?.owners || {}) };
      for (const [key, value] of Object.entries(owners)) if (value === drop) owners[key] = keep;
      owners[drop] = keep;
      delete owners[keep];
      state.accounts = { ...(state.accounts || {}), owners };
    });
    if (this.stores.has(drop)) await this.remove(drop);
    this.transient.delete(drop);
    return { owner: keep, recovered: keep !== mine && configuredAt(keep) > 0 };
  }

  async remove(owner) {
    this.stores.delete(owner);
    if (this.backend) { await this.backend.write(`monitor:${owner}`, {}); await this.#writeIndex(); }
    else await rm(join(this.dir, `${owner}.json`), { force: true });
  }

  #create(owner) {
    const store = new JsonStore(join(this.dir, `${owner}.json`), { backend: this.backend, key: `monitor:${owner}`, compact: true });
    const save = store.save.bind(store);
    store.save = async (state) => {
      await save(state);
      if (this.stores.has(owner)) return;
      this.transient.delete(owner); this.stores.set(owner, store);
      if (this.backend) await this.#writeIndex();
    };
    return store;
  }

  async #writeIndex() { await this.backend.write(INDEX_KEY, { owners: [...this.stores.keys()] }); }
}
