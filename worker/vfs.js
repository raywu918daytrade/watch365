// node:fs/promises for the Worker bundle: the indicator registry reads config/indicators/*.json, which are bundled here.
import lock from '../config/indicator-registry-lock.json';
import legacy from '../config/indicators/legacy-breakout-volume.json';
import rsi from '../config/indicators/rsi-cross.json';
import sma from '../config/indicators/sma-cross.json';
const FILES = new Map([
  ['/config/indicator-registry-lock.json', lock],
  ['/config/indicators/legacy-breakout-volume.json', legacy],
  ['/config/indicators/rsi-cross.json', rsi],
  ['/config/indicators/sma-cross.json', sma]
]);
const missing = (path) => Object.assign(new Error(`ENOENT ${path}`), { code:'ENOENT' });
export async function readFile(path) { if (!FILES.has(path)) throw missing(path); return JSON.stringify(FILES.get(path)); }
export async function readdir(dir) { const prefix = `${dir.replace(/\/$/, '')}/`; return [...FILES.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map((path) => path.slice(prefix.length)); }
export async function writeFile() {}
export async function mkdir() {}
export async function rename() {}
export async function rm() {}
export async function stat(path) { throw missing(path); }
export async function appendFile() {}
export async function unlink() {}
export default { readFile, readdir, writeFile, mkdir, rename, rm, stat, appendFile, unlink };
