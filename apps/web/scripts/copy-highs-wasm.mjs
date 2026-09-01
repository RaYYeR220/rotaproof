/**
 * Puts the HiGHS WebAssembly binary where the browser can fetch it.
 *
 * Emscripten resolves `highs.wasm` relative to the script that loaded it, which inside a
 * bundled worker is `/_next/static/chunks/` — a 404. Copying the binary to `public/` and
 * pointing `locateFile` at it is the fix; the path is read from the package's own export
 * map so a version bump cannot leave a stale copy behind.
 *
 * It must also stay same-origin: fetched cross-origin without CORS the module aborts with
 * "both async and sync fetching of the wasm failed".
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(here, '..', 'public', 'highs.wasm');

const source = require.resolve('highs/runtime');

mkdirSync(path.dirname(destination), { recursive: true });

const fresh =
  safeStat(destination)?.size === statSync(source).size &&
  (safeStat(destination)?.mtimeMs ?? 0) >= statSync(source).mtimeMs;

if (!fresh) {
  copyFileSync(source, destination);
  console.log(`highs.wasm -> public/ (${(statSync(destination).size / 1024).toFixed(0)} KB)`);
}

function safeStat(file) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}
