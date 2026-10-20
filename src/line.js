// LINE notifications through the LINE Messaging API (LINE Notify shut down in 2025-03).
// Setup: a LINE Official Account with a Messaging API channel; LINE_CHANNEL_SECRET verifies the webhook and
// LINE_CHANNEL_ACCESS_TOKEN (long-lived) sends messages. The webhook is POST /api/line/webhook.
//
// Linking: the dashboard asks for a one-time 6-digit code (10 minutes, kept in memory), the user adds the official
// account and sends the code, and the webhook stores { userId, displayName, visitor } in state.line.users. That list
// is never part of publicState; each browser only sees the accounts it linked itself. Every linked account gets the
// monitor's triggers, one push per monitor run (all stocks of the run in one message, to save the monthly quota).

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const API = 'https://api.line.me/v2/bot';
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_LINES = 20;

export function lineConfigFromEnv(env = process.env) {
  const secret = env.LINE_CHANNEL_SECRET?.trim() || '';
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || '';
  return { enabled: Boolean(secret && token), secret, token, siteUrl: env.PUBLIC_SITE_URL?.trim() || 'https://watch365.just1stock.com' };
}

export function verifySignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(signature, 'base64'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// One text message for all signals of a run. Signals come newest first; the message lists them in order of time.
export function signalsMessage(signals, { siteUrl } = {}) {
  if (!signals.length) return null;
  const daily = signals.every((signal) => signal.engine === 'daily_close');
  const head = daily ? `watch365｜13:00 新符合日 K 條件 ${signals.length} 檔` : `watch365｜盤中條件成立 ${signals.length} 檔`;
  const rule = signals[0].ruleName ? `條件：${signals[0].ruleName}` : null;
  const rows = signals.slice(0, MAX_LINES).map((signal) => {
    const name = signal.name && signal.name !== signal.symbol ? ` ${signal.name}` : '';
    const price = Number.isFinite(Number(signal.price)) ? ` ${Number(signal.price).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}` : '';
    const time = daily ? '' : ` ${taipeiTime(signal.barEnd || signal.triggeredAt)}`;
    return `・${signal.symbol}${name}${price}${time}`;
  });
  if (signals.length > MAX_LINES) rows.push(`…還有 ${signals.length - MAX_LINES} 檔，請到網站查看`);
  const tail = [daily ? '價格為 13:00 成交價，收盤前仍可能變動。' : null, '僅為條件通知，不是投資建議。', siteUrl || null].filter(Boolean);
  return [head, rule, '', ...rows, '', ...tail].filter((line) => line !== null).join('\n').slice(0, 4900);
}

function taipeiTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time + 8 * 3_600_000).toISOString().slice(11, 16);
}

export class LineNotifier {
  constructor({ config = lineConfigFromEnv(), store, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    this.config = config; this.store = store; this.fetch = fetchImpl; this.now = now; this.log = log;
    this.codes = new Map();   // code -> { visitor, expiresAt }
    this.botInfo = null;
  }

  get enabled() { return this.config.enabled; }

  users() { return this.store.getState().line?.users || []; }

  async bot() {
    if (!this.enabled) return null;
    if (this.botInfo && this.now() - this.botInfo.at < 3_600_000) return this.botInfo.data;
    try {
      const data = await this.call('GET', '/info');
      this.botInfo = { at: this.now(), data: { basicId: data.basicId || null, displayName: data.displayName || null, pictureUrl: data.pictureUrl || null } };
    } catch (error) {
      this.log.error('line: bot info failed', error.code || error.message);
      return this.botInfo?.data ?? null;
    }
    return this.botInfo.data;
  }

  // What the dashboard shows for one browser.
  async status(visitor) {
    if (!this.enabled) return { enabled: false };
    const bot = await this.bot();
    const linked = this.users().filter((user) => user.visitor === visitor).map(({ id, displayName, linkedAt }) => ({ id, displayName, linkedAt }));
    return { enabled: true, bot: bot && { basicId: bot.basicId, displayName: bot.displayName, addFriendUrl: bot.basicId ? `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` : null }, linked, totalLinked: this.users().length };
  }

  issueCode(visitor) {
    const at = this.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt <= at || entry.visitor === visitor) this.codes.delete(code);
    let code;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (this.codes.has(code));
    const expiresAt = at + LINK_CODE_TTL_MS;
    this.codes.set(code, { visitor, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async unlink(visitor, id) {
    let removed = 0;
    await this.store.update((state) => {
      const users = state.line?.users || [];
      const keep = users.filter((user) => !(user.visitor === visitor && (!id || user.id === id)));
      removed = users.length - keep.length;
      state.line = { ...(state.line || {}), users: keep };
    });
    return { removed };
  }

  async sendTest(visitor) {
    const targets = this.users().filter((user) => user.visitor === visitor);
    if (!targets.length) return { sent: 0 };
    await this.pushTo(targets, 'watch365 測試通知：LINE 綁定成功，條件成立時會在這裡通知你。');
    return { sent: targets.length };
  }

  // Webhook body (already signature-checked). Returns how many events were handled.
  async handleWebhook(body) {
    let handled = 0;
    for (const event of body?.events || []) {
      const userId = event.source?.type === 'user' ? event.source.userId : null;
      if (!userId) continue;
      try {
        if (event.type === 'follow') { handled += 1; await this.reply(event.replyToken, '歡迎使用 watch365！請到網站「我的監控」按「綁定 LINE」，再把畫面上的 6 位數綁定碼傳到這裡。'); }
        else if (event.type === 'unfollow') { handled += 1; await this.removeUser(userId); }
        else if (event.type === 'message' && event.message?.type === 'text') { handled += 1; await this.onText(userId, event.message.text, event.replyToken); }
      } catch (error) { this.log.error('line: webhook event failed', error.code || error.message); }
    }
    return handled;
  }

  async onText(userId, text, replyToken) {
    const code = String(text || '').replace(/\s+/g, '').match(/^(?:綁定碼?[:：]?)?(\d{6})$/)?.[1];
    if (!code) {
      const linked = this.users().some((user) => user.userId === userId);
      await this.reply(replyToken, linked ? '已綁定 watch365，條件成立時會在這裡通知你。要解除請到網站「我的監控」按「解除綁定」，或封鎖這個帳號。' : '請傳網站「我的監控 → 綁定 LINE」顯示的 6 位數綁定碼。');
      return;
    }
    const entry = this.codes.get(code);
    if (!entry || entry.expiresAt <= this.now()) { this.codes.delete(code); await this.reply(replyToken, '綁定碼錯誤或已過期（10 分鐘內有效），請到網站重新產生。'); return; }
    this.codes.delete(code);
    let displayName = null;
    try { displayName = (await this.call('GET', `/profile/${encodeURIComponent(userId)}`)).displayName || null; } catch { /* name is optional */ }
    const linkedAt = new Date(this.now()).toISOString();
    await this.store.update((state) => {
      const users = (state.line?.users || []).filter((user) => !(user.userId === userId && user.visitor === entry.visitor));
      users.push({ id: createHmac('sha256', 'watch365-line').update(`${userId}|${entry.visitor}`).digest('base64url').slice(0, 12), userId, displayName, visitor: entry.visitor, linkedAt });
      state.line = { ...(state.line || {}), users };
    });
    await this.reply(replyToken, '綁定成功！之後監控條件成立時，會在這裡通知你。');
  }

  async removeUser(userId) {
    await this.store.update((state) => { state.line = { ...(state.line || {}), users: (state.line?.users || []).filter((user) => user.userId !== userId) }; });
  }

  // Called after every monitor run with that run's new signals. Never throws.
  async notifySignals(signals) {
    if (!this.enabled || !signals?.length) return { sent: 0 };
    const users = this.users();
    if (!users.length) return { sent: 0 };
    const text = signalsMessage([...signals].reverse(), { siteUrl: this.config.siteUrl });
    try {
      await this.pushTo(users, text);
      return { sent: users.length };
    } catch (error) {
      this.log.error('line: push failed', error.code || error.message);
      return { sent: 0, error: error.code || 'LINE_PUSH_FAILED' };
    }
  }

  async pushTo(users, text) {
    const ids = [...new Set(users.map((user) => user.userId))];
    for (let index = 0; index < ids.length; index += 500) {
      const to = ids.slice(index, index + 500);
      if (to.length === 1) await this.call('POST', '/message/push', { to: to[0], messages: [{ type: 'text', text }] });
      else await this.call('POST', '/message/multicast', { to, messages: [{ type: 'text', text }] });
    }
  }

  async reply(replyToken, text) {
    if (!replyToken) return;
    await this.call('POST', '/message/reply', { replyToken, messages: [{ type: 'text', text }] });
  }

  async call(method, path, body) {
    const response = await this.fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${this.config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`LINE API ${response.status}: ${detail.slice(0, 200)}`), { code: response.status === 401 ? 'LINE_UNAUTHORIZED' : response.status === 429 ? 'LINE_QUOTA_EXCEEDED' : 'LINE_API_FAILED', statusCode: response.status });
    }
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  }
}
