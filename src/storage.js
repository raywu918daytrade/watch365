import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { legacyStrategy } from './indicatorRegistry.js';

const DEFAULT_STATE = {
  settings: {
    trialUser: {
      id: 'trial-001',
      name: '內部試用者',
      status: 'active'
    },
    market: 'TW',
    provider: 'hf_dataset',
    enabled: false,
    pollIntervalSeconds: 60,
    watchlist: [],
    monitorTask: {
      name: '台股突破量能監控',
      onboardingCompleted: false,
      completedAt: null
    },
    rule: {
      volumeBaselineBars: 20,
      volumeMultiplier: 2,
      cooldownMinutes: 30
    },
    strategy: legacyStrategy('1970-01-01T00:00:00.000Z'),
    notification: {
      channel: 'browser',
      target: '本機瀏覽器'
    }
  },
  runtime: {
    isMonitoring: false,
    lastRunAt: null,
    lastProviderStatus: '尚未執行',
    lastError: null,
    coverageStatus: 'unknown',
    coverageRevision: null,
    coverageUpdatedDate: null,
    coverageError: null,
    coverageInterrupted: false,
    selectedWatchlistCount: 0,
    effectiveWatchlistCount: null,
    uncoveredWatchlistCount: null,
    effectiveWatchlist: []
  },
  positions: {},
  sessions: {},
  indicatorSessions: {},
  decisions: [],
  dedupe: {},
  quotes: [],
  signals: [],
  notifications: [],
  logs: [],
  line: { users: [] }
};

export class JsonStore {
  constructor(filePath, { backend = null, key = 'state' } = {}) {
    this.filePath = filePath;
    this.backend = backend;
    this.key = key;
    this.state = structuredClone(DEFAULT_STATE);
    this.updateQueue = Promise.resolve();
  }

  async load() {
    if (this.backend) {
      const stored = await this.backend.read(this.key);
      if (stored) this.state = mergeState(DEFAULT_STATE, stored);
      else await this.save();
      return this.state;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = mergeState(DEFAULT_STATE, JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.state;
  }

  getState() {
    return this.state;
  }

  async update(mutator) {
    const operation=this.updateQueue.then(async()=>{
      const next = structuredClone(this.state);
      const result = await mutator(next);
      trimState(next);
      await this.save(next);
      this.state = next;
      return result ?? this.state;
    });
    this.updateQueue=operation.catch(()=>{});
    return operation;
  }

  async save(state = this.state) {
    if (this.backend) return this.backend.write(this.key, state);
    const temporary=`${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try{await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');await rename(temporary,this.filePath);}
    catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
  }
}

export function publicState(state) {
  return {
    settings: state.settings,
    runtime: state.runtime,
    quotes: state.quotes.slice(0, 50),
    signals: state.signals.slice(0, 100),
    notifications: state.notifications.slice(0, 100),
    logs: state.logs.slice(0, 150),
    positions: state.positions,
    decisions: state.decisions.slice(0, 200)
  };
}

export function appendLog(state, level, message, detail = null) {
  state.logs.unshift({
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message,
    detail
  });
}

function mergeState(defaults, loaded) {
  const merged = {
    ...structuredClone(defaults),
    ...loaded,
    settings: {
      ...defaults.settings,
      ...(loaded.settings || {}),
      trialUser: {
        ...defaults.settings.trialUser,
        ...((loaded.settings || {}).trialUser || {})
      },
      rule: {
        ...defaults.settings.rule,
        ...((loaded.settings || {}).rule || {})
      },
      notification: {
        ...defaults.settings.notification,
        ...((loaded.settings || {}).notification || {})
      },
      monitorTask: {
        ...defaults.settings.monitorTask,
        ...((loaded.settings || {}).monitorTask || {})
      }
    },
    runtime: {
      ...defaults.runtime,
      ...(loaded.runtime || {})
    },
    positions: loaded.positions || {},
    sessions: loaded.sessions || {},
    indicatorSessions: loaded.indicatorSessions || {},
    decisions: loaded.decisions || [],
    dedupe: loaded.dedupe || {},
    quotes: loaded.quotes || [],
    signals: loaded.signals || [],
    notifications: loaded.notifications || [],
    logs: loaded.logs || [],
    line: { users: loaded.line?.users || [] }
  };

  merged.settings.market = 'TW';
  merged.settings.provider = 'hf_dataset';
  merged.settings.watchlist = (merged.settings.watchlist || [])
    .filter((item) => /^\d{4,6}$/.test(String(item.symbol)))
    .map((item) => ['TWSE', 'TPEx'].includes(item.market)
      ? { ...item, needsMarketCorrection: false }
      : { ...item, market: null, needsMarketCorrection: true });
  if (!merged.settings.watchlist.length) merged.settings.watchlist = structuredClone(defaults.settings.watchlist);
  const loadedTask = (loaded.settings || {}).monitorTask;
  if (!loadedTask && merged.settings.watchlist.length) {
    merged.settings.monitorTask = {
      name: '台股突破量能監控',
      onboardingCompleted: true,
      completedAt: loaded.runtime?.lastRunAt || null
    };
  }
  merged.settings.rule.volumeBaselineBars = 20;
  merged.settings.rule.volumeMultiplier = 2;
  merged.settings.rule.cooldownMinutes = 30;
  if (!(loaded.settings || {}).strategy) merged.settings.strategy = legacyStrategy(loaded.runtime?.lastRunAt || '1970-01-01T00:00:00.000Z');

  return merged;
}

function trimState(state) {
  state.quotes = state.quotes.slice(0, 50);
  state.signals = state.signals.slice(0, 200);
  state.notifications = state.notifications.slice(0, 200);
  state.logs = state.logs.slice(0, 400);
  state.decisions = state.decisions.slice(0, 1000);
}
