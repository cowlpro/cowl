// Build: bundel JS (esbuild) + salin halaman HTML dengan ?v=<versi> supaya cache browser selalu segar tiap deploy.
import { build } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const V = Date.now().toString(36);
const entries = ['app', 'landing'].filter((n) => {
  try { readFileSync(path.join(root, 'app/src', n + '.js')); return true; } catch { return false; }
});
await build({
  entryPoints: entries.map((n) => path.join(root, 'app/src', n + '.js')),
  outdir: path.join(root, 'app/public/assets'),
  bundle: true, format: 'esm', minify: true, target: ['es2020'], sourcemap: false, legalComments: 'none',
  loader: { '.json': 'json' }, logLevel: 'warning',
});
for (const f of readdirSync(path.join(root, 'app/pages'))) {
  if (!f.endsWith('.html')) continue;
  const html = readFileSync(path.join(root, 'app/pages', f), 'utf8').replaceAll('__V__', V);
  writeFileSync(path.join(root, 'app/public', f), html);
}
console.log('build', V, entries.join(', '));
