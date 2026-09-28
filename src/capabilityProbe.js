import { readFile } from 'node:fs/promises';

export const CAPABILITY_KEYS = Object.freeze([
  'HF_REPO_ID', 'HF_TOKEN'
]);

export async function probeCapabilities(paths) {
  const values = new Map();
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
        values.set(match[1], Boolean(value) && !/^<.*>$/.test(value));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return CAPABILITY_KEYS.map((key) => ({ key, status: 'error', errorCode: error.code || 'READ_ERROR' }));
    }
  }
  return CAPABILITY_KEYS.map((key) => {
    const available = values.get(key) === true;
    return { key, status: available ? 'available' : 'unavailable' };
  });
}

export function formatCapabilityReport(results) {
  return results.map(({ key, status, errorCode }) => `${key}: ${status}${errorCode ? ` (${errorCode})` : ''}`).join('\n');
}
