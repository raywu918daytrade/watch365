// Node built-ins the browser bundle never calls (file storage, child processes); imports resolve to no-ops.
const fail = () => { throw new Error('not available in the browser'); };
export const readFile = fail, writeFile = fail, mkdir = fail, rename = fail, stat = fail, readdir = fail, unlink = fail, appendFile = fail, rm = fail;
export const join = (...parts) => parts.join('/'), dirname = (path) => String(path).split('/').slice(0, -1).join('/'), resolve = (...parts) => parts.join('/'), normalize = (path) => path, extname = (path) => (String(path).match(/\.[^./]*$/) || [''])[0], basename = (path) => String(path).split('/').pop();
export const fileURLToPath = (url) => String(url), pathToFileURL = (path) => new URL(path, 'file:///');
export const fork = fail, spawn = fail, createReadStream = fail, createInterface = fail, existsSync = () => false, tmpdir = () => '/tmp';
export const asyncBufferFromFile = fail;
export default {};
