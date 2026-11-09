// Bundles the browser engine (web/localApi.js + web/engineWorker.js) into public/engine/ for the static site.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const shim = (name) => fileURLToPath(new URL(`../web/shims/${name}.js`, import.meta.url));
const empty = shim('empty');
const alias = { 'node:crypto':shim('crypto') };
for (const name of ['fs', 'fs/promises', 'path', 'url', 'child_process', 'os', 'readline', 'http', 'zlib']) alias[`node:${name}`] = empty;
await build({
  entryPoints:{ 'local-api':'web/localApi.js', 'engine-worker':'web/engineWorker.js' },
  outdir:'public/engine', bundle:true, format:'esm', platform:'browser', target:'es2022', minify:true, sourcemap:true,
  mainFields:['browser', 'main'], alias, define:{ 'process.env':'{}' }, logLevel:'info'
});
