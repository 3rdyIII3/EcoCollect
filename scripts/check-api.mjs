/**
 * Smoke test: import every API handler and assert it exports a function.
 *
 * Vite only bundles src/, so a broken import inside api/ would not fail the build -
 * it would fail the first time Vercel cold-starts that function. This catches it.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.JWT_SECRET ||= 'test-secret-that-is-definitely-long-enough-32chars';
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = (await walk(root)).sort();
let pass = 0;
let fail = 0;

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');

  // _lib/ holds shared modules, not request handlers - Vercel never routes to them,
  // so they are imported transitively by the handlers instead of loaded directly.
  if (rel.startsWith('_lib/')) continue;

  try {
    const mod = await import(pathToFileURL(file).href);
    const handler = mod.default;
    if (typeof handler !== 'function') {
      throw new Error(`default export is ${typeof handler}, expected function`);
    }
    if (handler.length === 0) {
      // Vercel calls handler(req, res); arity 1 is fine, 0 would ignore the request.
      throw new Error('handler takes no arguments');
    }
    console.log(`PASS  ${rel}`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  ${rel}\n        ${err.message}`);
    fail += 1;
  }
}

console.log(`\n${pass} handlers loaded, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
