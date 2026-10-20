import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { LineNotifier, signalsMessage, verifySignature } from './line.js';

function memoryStore(state = { line: { users: [] } }) {
  return { getState: () => state, update: async (fn) => { fn(state); return state; } };
}
function fakeFetch(calls, profile = { displayName: 'Ray' }) {
  return async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const payload = url.includes('/profile/') ? profile : url.endsWith('/info') ? { basicId: '@w365', displayName: 'watch365' } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}
const config = { enabled: true, secret: 's3cret', token: 'tok', siteUrl: 'https://example.test' };

test('verifySignature accepts the LINE HMAC and rejects anything else', () => {
  const body = Buffer.from('{"events":[]}');
  const signature = createHmac('sha256', 's3cret').update(body).digest('base64');
  assert.equal(verifySignature(body, signature, 's3cret'), true);
  assert.equal(verifySignature(body, signature, 'other'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('a code sent from LINE links that account to the browser that asked for it', async () => {
  const calls = [], store = memoryStore();
  const line = new LineNotifier({ config, store, fetchImpl: fakeFetch(calls) });
  const { code } = line.issueCode('visitorA');
  await line.handleWebhook({ events: [{ type: 'message', replyToken: 'r1', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: ` ${code} ` } }] });
  assert.deepEqual(store.getState().line.users.map(({ userId, visitor, displayName }) => ({ userId, visitor, displayName })), [{ userId: 'U1', visitor: 'visitorA', displayName: 'Ray' }]);
  assert.match(calls.at(-1).body.messages[0].text, /綁定成功/);
  assert.equal((await line.status('visitorA')).linked.length, 1);
  assert.equal((await line.status('visitorB')).linked.length, 0);
  // the code is single-use
  await line.handleWebhook({ events: [{ type: 'message', replyToken: 'r2', source: { type: 'user', userId: 'U2' }, message: { type: 'text', text: code } }] });
  assert.equal(store.getState().line.users.length, 1);
  assert.match(calls.at(-1).body.messages[0].text, /過期/);
});

test('expired codes do not link; unfollow and unlink remove the account', async () => {
  let now = 0;
  const calls = [], store = memoryStore();
  const line = new LineNotifier({ config, store, fetchImpl: fakeFetch(calls), now: () => now });
  const { code } = line.issueCode('v');
  now = 11 * 60 * 1000;
  await line.onText('U1', code, 'r');
  assert.equal(store.getState().line.users.length, 0);
  const fresh = line.issueCode('v');
  await line.onText('U1', fresh.code, 'r');
  await line.onText('U2', line.issueCode('w').code, 'r');
  assert.equal(store.getState().line.users.length, 2);
  await line.handleWebhook({ events: [{ type: 'unfollow', source: { type: 'user', userId: 'U1' } }] });
  assert.deepEqual(store.getState().line.users.map((user) => user.userId), ['U2']);
  assert.deepEqual(await line.unlink('v'), { removed: 0 });
  assert.deepEqual(await line.unlink('w'), { removed: 1 });
});

test('one run of signals becomes one message to the monitor owner\'s linked accounts only', async () => {
  const calls = [], store = memoryStore({ line: { users: [{ userId: 'U1', visitor: 'a' }, { userId: 'U2', visitor: 'a' }, { userId: 'U3', visitor: 'b' }] } });
  const line = new LineNotifier({ config, store, fetchImpl: fakeFetch(calls) });
  const signals = [
    { engine: 'daily_close', symbol: '2317', name: '鴻海', price: 210.5, ruleName: 'SMA(5) 上穿 SMA(20)' },
    { engine: 'daily_close', symbol: '2330', name: '台積電', price: 1050, ruleName: 'SMA(5) 上穿 SMA(20)' }
  ];
  assert.deepEqual(await line.notifySignals(signals), { sent: 0 });
  assert.deepEqual(await line.notifySignals(signals, { owner: 'a' }), { sent: 2 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /multicast$/);
  assert.deepEqual(calls[0].body.to, ['U1', 'U2']);
  const text = calls[0].body.messages[0].text;
  assert.match(text, /13:00 新符合日 K 條件 2 檔/);
  assert.ok(text.indexOf('2330') < text.indexOf('2317'), 'oldest first');
  assert.match(text, /不是投資建議/);
});

test('signalsMessage shows intraday times in Taipei and caps the list', () => {
  const signals = Array.from({ length: 25 }, (_, index) => ({ symbol: String(1000 + index), name: String(1000 + index), price: 10, barEnd: '2026-10-20T02:31:00.000Z', ruleName: 'RSI' }));
  const text = signalsMessage(signals);
  assert.match(text, /盤中條件成立 25 檔/);
  assert.match(text, /・1000 10 10:31/);
  assert.match(text, /還有 5 檔/);
});

test('linking an account linked from another browser before joins the browsers and says the monitor is back', async () => {
  const calls = [], store = memoryStore({ line: { users: [{ id: 'old', userId: 'U1', visitor: 'phone', displayName: 'Ray' }] } });
  const owners = {}, joined = [];
  const line = new LineNotifier({ config, store, fetchImpl: fakeFetch(calls), ownerOf: (visitor) => owners[visitor] || visitor, onLinked: async ({ visitor, earlierVisitor }) => { joined.push([visitor, earlierVisitor]); owners[visitor] = earlierVisitor; return { recovered: true }; } });
  await line.onText('U1', line.issueCode('laptop').code, 'r');
  assert.deepEqual(joined, [['laptop', 'phone']]);
  assert.match(calls.at(-1).body.messages[0].text, /已找回你之前設定的監控/);
  // Both browsers are one person now: one account shown, one push per run, and unlink from either removes it.
  assert.equal((await line.status('laptop')).linked.length, 1);
  assert.deepEqual(await line.notifySignals([{ symbol: '2330', price: 1 }], { owner: 'phone' }), { sent: 1 });
  assert.deepEqual(await line.unlink('laptop'), { removed: 2 });
  // A first-time link calls nothing.
  await line.onText('U9', line.issueCode('other').code, 'r');
  assert.equal(joined.length, 1);
  assert.match(calls.at(-1).body.messages[0].text, /^綁定成功！之後/);
});
