// Daily backup of the data folder (production keeps its JSON files on a Railway volume, STORAGE=files) to a private
// Hugging Face dataset, once per day after DAILY_BACKUP_AT (Taipei). Off unless HF_BACKUP_REPO is set.
// HF_BACKUP_TOKEN (falls back to HF_TOKEN) needs write access; the repo is created private on first use.
// Each day is one commit replacing backups/latest/ and adding backups/YYYY-MM-DD/ (events.jsonl only in latest/).
// The data holds LINE user ids and visitor ids, so the repo must stay private: a public repo is refused.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HF = 'https://huggingface.co';
const DAILY_BACKUP_AT = 14 * 60 + 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function backupConfigFromEnv(env = process.env) {
  const repo = env.HF_BACKUP_REPO?.trim() || '';
  const token = env.HF_BACKUP_TOKEN?.trim() || env.HF_TOKEN?.trim() || '';
  return { enabled: Boolean(repo && token), repo, token };
}

export class DataBackup {
  constructor({ dir, config = backupConfigFromEnv(), fetchImpl = globalThis.fetch, log = console } = {}) {
    this.dir = dir; this.config = config; this.fetch = fetchImpl; this.log = log;
    this.lastDay = null; this.running = false; this.repoReady = false;
  }

  // Called from a timer; does at most one backup per Taipei day.
  async tick(now = new Date()) {
    if (!this.config.enabled || this.running) return null;
    const taipei = new Date(now.getTime() + 8 * 3_600_000), day = taipei.toISOString().slice(0, 10);
    if (this.lastDay === day || taipei.getUTCHours() * 60 + taipei.getUTCMinutes() < DAILY_BACKUP_AT) return null;
    this.running = true;
    try { const result = await this.run(day); this.lastDay = day; this.log.log(`backup: ${result.files} files to ${this.config.repo}`); return result; }
    catch (error) { this.log.error('backup: failed', error.code || error.message); return { error: error.code || 'BACKUP_FAILED' }; }
    finally { this.running = false; }
  }

  async run(day) {
    await this.ensureRepo();
    // Top-level files plus every person's monitor (monitors/<owner>.json, src/monitors.js).
    const top = (await readdir(this.dir).catch(() => [])).filter((name) => /\.(json|jsonl)$/.test(name)).sort();
    const names = [...top, ...(await readdir(join(this.dir, 'monitors')).catch(() => [])).filter((name) => name.endsWith('.json')).sort().map((name) => `monitors/${name}`)];
    const files = [];
    for (const name of names) {
      const content = await readFile(join(this.dir, name));
      if (content.length > MAX_FILE_BYTES) { this.log.error(`backup: ${name} is ${content.length} bytes, skipped`); continue; }
      files.push({ path: `backups/latest/${name}`, content });
      if (!name.endsWith('.jsonl')) files.push({ path: `backups/${day}/${name}`, content });
    }
    if (!files.length) return { files: 0 };
    const lines = [{ key: 'header', value: { summary: `watch365 backup ${day}` } }, ...files.map((file) => ({ key: 'file', value: { path: file.path, encoding: 'base64', content: file.content.toString('base64') } }))];
    await this.call('POST', `/api/datasets/${this.config.repo}/commit/main`, lines.map((line) => JSON.stringify(line)).join('\n'), 'application/x-ndjson');
    return { files: files.length };
  }

  async ensureRepo() {
    if (this.repoReady) return;
    const [organization, name] = this.config.repo.split('/');
    const info = await this.call('GET', `/api/datasets/${this.config.repo}`).catch((error) => { if (error.statusCode === 404 || error.statusCode === 401) return null; throw error; });
    if (!info) await this.call('POST', '/api/repos/create', JSON.stringify({ type: 'dataset', name, organization, private: true }), 'application/json');
    else if (info.private === false) throw Object.assign(new Error(`${this.config.repo} is public`), { code: 'BACKUP_REPO_PUBLIC' });
    this.repoReady = true;
  }

  async call(method, path, body, contentType) {
    const response = await this.fetch(`${HF}${path}`, { method, headers: { Authorization: `Bearer ${this.config.token}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, body, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`HF ${response.status}: ${detail.slice(0, 200)}`), { code: response.status === 401 || response.status === 403 ? 'BACKUP_UNAUTHORIZED' : 'BACKUP_HF_FAILED', statusCode: response.status });
    }
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  }
}
