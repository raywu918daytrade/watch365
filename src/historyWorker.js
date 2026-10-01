// Runs one history lookup in a forked child with its own V8 heap cap (--max-old-space-size), so a
// lookup that needs more memory than the container can spare dies on its own instead of taking the
// live monitor down with it. Talks to the parent over IPC.
import { runHistory } from './history.js';

const { strategy, watchlist } = JSON.parse(process.argv[2] || '{}');
const send = (message) => { if (process.send) process.send(message); };
try {
  const result = await runHistory(strategy, watchlist, { onProgress: (progress) => send({ type: 'progress', progress }) });
  send({ type: 'done', result });
} catch (error) {
  send({ type: 'error', code: error?.code || null, statusCode: error?.statusCode || null, message: error?.message || String(error) });
}
process.exit(0);
