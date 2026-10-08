import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryIndexClient, inSessionWindow } from './historyIndexClient.js';
import { describeCondition } from './conditionState.js';

const close = { op:'source', field:'close' };
const cond = (value) => { const ast = { op:'gte', left:close, right:{ op:'constant', value } }; return { key:describeCondition(ast).key, ast }; };
const bars = (date, closes) => closes.map((price, index) => ({ barEnd:Date.parse(`${date}T01:01:00.000Z`) + index * 60_000, open:price, high:price, low:price, close:price, volume:1000 }));
const quiet = { error() {}, warn() {}, info() {} };

test('worker process: loads, precomputes once, answers combined queries, survives a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-index-'));
  const fixture = join(dir, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ '2026-10-07':{ 2330:bars('2026-10-07', [99, 101]), 2317:bars('2026-10-07', [50]) }, '2026-10-08':{ 2330:bars('2026-10-08', [99, 99, 102]) } }));
  process.env.WATCH365_HISTORY_FIXTURE = fixture;
  const client = new HistoryIndexClient({ getSymbols:async () => ['2330', '2317'], log:quiet, heapMb:128 });
  try {
    await client.start();
    const warm = await client.ensure([cond(100), cond(101)]);
    assert.equal(warm.conditions, 2);
    const result = await client.query({ filters:[cond(100), cond(101)], candidates:[cond(50)] });
    assert.deepEqual(result.steps.map((step) => [step.triggeredSymbols, step.totalEvents]), [[1, 2], [1, 2]]);
    assert.equal(result.computed, 1);                       // only the never-seen candidate is computed; the two filters are reused
    assert.deepEqual(result.candidates[0], { key:cond(50).key, triggeredSymbols:1, totalEvents:2 });
    assert.equal(result.steps[1].events.length, 2);
    // Crash: pending work fails cleanly, the next request respawns the worker and restores its conditions.
    client.child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
    let again;
    for (let attempt = 0; attempt < 50; attempt++) { again = await client.query({ filters:[cond(100)] }); if (!again.loading) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.equal(again.steps[0].totalEvents, 2);
    assert.equal(client.restarts, 1);
  } finally {
    client.stop(); delete process.env.WATCH365_HISTORY_FIXTURE; await rm(dir, { recursive:true, force:true });
  }
});

test('session window: weekdays 08:55–13:45 Taipei', () => {
  assert.equal(inSessionWindow(new Date('2026-10-08T02:00:00Z')), true);    // Thu 10:00
  assert.equal(inSessionWindow(new Date('2026-10-08T06:00:00Z')), false);   // Thu 14:00
  assert.equal(inSessionWindow(new Date('2026-10-10T02:00:00Z')), false);   // Sat
});
