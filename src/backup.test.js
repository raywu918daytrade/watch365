import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataBackup } from './backup.js';

const quiet = { log() {}, error() {} };
function fakeHf(calls, { exists = true, isPrivate = true } = {}) {
  return async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (options.method === 'GET') return exists ? { ok: true, status: 200, text: async () => JSON.stringify({ private: isPrivate }) } : { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => '{}' };
  };
}

test('backs up once per Taipei day after 14:30, creating the private repo when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-'));
  try {
    await writeFile(join(dir, 'watch365.json'), '{"a":1}');
    await writeFile(join(dir, 'events.jsonl'), '{"e":1}\n');
    await writeFile(join(dir, 'notes.txt'), 'skip');
    const calls = [];
    const backup = new DataBackup({ dir, config: { enabled: true, repo: 'ray/w365-backup', token: 't' }, fetchImpl: fakeHf(calls, { exists: false }), log: quiet });
    assert.equal(await backup.tick(new Date('2026-10-20T06:00:00Z')), null);   // 14:00 Taipei
    assert.deepEqual(await backup.tick(new Date('2026-10-20T06:31:00Z')), { files: 3 });
    assert.deepEqual(JSON.parse(calls[1].body), { type: 'dataset', name: 'w365-backup', organization: 'ray', private: true });
    const lines = calls[2].body.split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.slice(1).map((line) => line.value.path), ['backups/latest/events.jsonl', 'backups/latest/watch365.json', 'backups/2026-10-20/watch365.json']);
    assert.equal(Buffer.from(lines[2].value.content, 'base64').toString(), '{"a":1}');
    assert.equal(await backup.tick(new Date('2026-10-20T09:00:00Z')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refuses a public backup repo', async () => {
  const backup = new DataBackup({ dir: '/nonexistent', config: { enabled: true, repo: 'ray/public', token: 't' }, fetchImpl: fakeHf([], { isPrivate: false }), log: quiet });
  assert.deepEqual(await backup.tick(new Date('2026-10-20T07:00:00Z')), { error: 'BACKUP_REPO_PUBLIC' });
});
