import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorStores } from './monitors.js';
import { JsonStore } from './storage.js';

const A = 'AAAAAAAAAAAAAAAAAAAAAA', B = 'BBBBBBBBBBBBBBBBBBBBBB', C = 'CCCCCCCCCCCCCCCCCCCCCC';
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'monitors-'));
  const shared = new JsonStore(join(dir, 'watch365.json'));
  await shared.load();
  const monitors = await new MonitorStores({ dir: join(dir, 'monitors'), shared }).load();
  return { dir, shared, monitors };
}
const configure = (store, name, completedAt) => store.update((state) => { state.settings.enabled = true; state.settings.strategy = { ...state.settings.strategy, name }; state.settings.monitorTask = { name, onboardingCompleted: true, completedAt }; });

test('each browser has its own monitor, and only written monitors are files', async () => {
  const { dir, shared, monitors } = await setup();
  try {
    await configure(monitors.get(A), 'A 的條件', '2026-10-20T01:00:00.000Z');
    await configure(monitors.get(B), 'B 的條件', '2026-10-20T02:00:00.000Z');
    monitors.get(C);   // only looked at the page
    assert.equal(monitors.get(A).getState().settings.strategy.name, 'A 的條件');
    assert.equal(monitors.get(B).getState().settings.strategy.name, 'B 的條件');
    assert.equal(monitors.get(C).getState().settings.monitorTask.onboardingCompleted, false);
    assert.deepEqual((await readdir(join(dir, 'monitors'))).sort(), [`${A}.json`, `${B}.json`]);
    assert.deepEqual(monitors.all().map(([owner]) => owner).sort(), [A, B]);
    const reloaded = await new MonitorStores({ dir: join(dir, 'monitors'), shared }).load();
    assert.equal(reloaded.get(B).getState().settings.strategy.name, 'B 的條件');
    assert.throws(() => monitors.get('../x'), { code: 'VISITOR_INVALID' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('linking the same LINE account from a new browser brings the earlier monitor back', async () => {
  const { dir, shared, monitors } = await setup();
  try {
    await configure(monitors.get(A), 'A 的條件', '2026-10-20T01:00:00.000Z');
    monitors.get(B);   // new phone, nothing set up
    assert.deepEqual(await monitors.join(B, A), { owner: A, recovered: true });
    assert.equal(monitors.ownerOf(B), A);
    assert.equal(monitors.get(monitors.ownerOf(B)).getState().settings.strategy.name, 'A 的條件');
    assert.deepEqual(shared.getState().accounts.owners, { [B]: A });
    // A third browser joined to B lands on the same person.
    assert.deepEqual(await monitors.join(C, B), { owner: A, recovered: true });
    assert.deepEqual(await monitors.join(C, A), { owner: A, recovered: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('when both browsers have a monitor, the one set up last is kept', async () => {
  const { dir, shared, monitors } = await setup();
  try {
    await configure(monitors.get(A), '舊的', '2026-10-19T01:00:00.000Z');
    await configure(monitors.get(B), '新的', '2026-10-20T01:00:00.000Z');
    assert.deepEqual(await monitors.join(B, A), { owner: B, recovered: false });
    assert.equal(monitors.ownerOf(A), B);
    assert.equal(monitors.get(monitors.ownerOf(A)).getState().settings.strategy.name, '新的');
    assert.deepEqual(await readdir(join(dir, 'monitors')), [`${B}.json`]);
    assert.deepEqual(shared.getState().accounts.owners, { [A]: B });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
