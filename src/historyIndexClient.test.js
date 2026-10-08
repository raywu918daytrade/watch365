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

test('worker process: daily filters answer from daily history and restrict each minute day to the previous close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-index-'));
  const fixture = join(dir, 'fixture.json'), dailyFixture = join(dir, 'daily.json');
  await writeFile(fixture, JSON.stringify({ '2026-10-07':{ 2330:bars('2026-10-07', [99, 101]), 2317:bars('2026-10-07', [99, 101]) }, '2026-10-08':{ 2330:bars('2026-10-08', [99, 99, 102]) } }));
  const day = (date, price) => ({ date, open:price, high:price, low:price, close:price, volume:1000 });
  // 2330 closes 105 on 10/06 (met), 95 on 10/07 (not met); 2317 never.
  await writeFile(dailyFixture, JSON.stringify({ 2330:[day('2026-10-05', 90), day('2026-10-06', 105), day('2026-10-07', 95)], 2317:[day('2026-10-05', 50), day('2026-10-06', 50), day('2026-10-07', 50)] }));
  process.env.WATCH365_HISTORY_FIXTURE = fixture; process.env.WATCH365_DAILY_FIXTURE = dailyFixture;
  const client = new HistoryIndexClient({ getSymbols:async () => ['2330', '2317'], log:quiet, heapMb:128 });
  try {
    await client.start();
    let result;
    for (let attempt = 0; attempt < 50; attempt++) { result = await client.query({ filters:[cond(100)], daily:{ filters:[cond(100)], candidates:[cond(40)], list:true } }); if (!result.loading && !result.daily?.loading) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.equal(result.daily.latestDate, '2026-10-07');
    assert.equal(result.daily.steps[0].latestCount, 0);                  // nobody closed ≥ 100 on 10/07
    assert.deepEqual(result.daily.steps[0].days.map((item) => item.count), [0, 1, 0]);
    assert.equal(result.daily.candidates[0].latestCount, 0);
    // Minute day 10/07 uses the 10/06 list (2330 only); 10/08 uses 10/07 (empty): one trigger in total.
    assert.equal(result.steps[0].totalEvents, 1);
    assert.equal(result.steps[0].triggeredSymbols, 1);
    const plain = await client.query({ filters:[cond(100)] });
    assert.equal(plain.steps[0].totalEvents, 3);
  } finally {
    client.stop(); delete process.env.WATCH365_HISTORY_FIXTURE; delete process.env.WATCH365_DAILY_FIXTURE; await rm(dir, { recursive:true, force:true });
  }
});

test('session window: weekdays 08:55–13:45 Taipei', () => {
  assert.equal(inSessionWindow(new Date('2026-10-08T02:00:00Z')), true);    // Thu 10:00
  assert.equal(inSessionWindow(new Date('2026-10-08T06:00:00Z')), false);   // Thu 14:00
  assert.equal(inSessionWindow(new Date('2026-10-10T02:00:00Z')), false);   // Sat
});
