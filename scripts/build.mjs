// Build dist/ with esbuild and report sizes.
//   dist/flickerscope.mjs     ES module (readable)
//   dist/flickerscope.cjs     CommonJS (for require)
//   dist/flickerscope.min.js  minified IIFE, global `FlickerScope` (script tags, CDNs)
//   dist/flickerscope.d.ts    TypeScript declarations (and .d.cts for require)
// Also copies the minified build to docs/ for the demo page.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const banner = `/*! flickerscope v${pkg.version} | MIT License | (c) 2026 Silent Co, LLC */`;
const common = {
  entryPoints: [at('src/index.js')],
  bundle: true,
  target: 'es2020',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: { js: banner },
  legalComments: 'none',
  logLevel: 'warning',
};

mkdirSync(at('dist'), { recursive: true });
await build({ ...common, format: 'esm', outfile: at('dist/flickerscope.mjs') });
await build({ ...common, format: 'cjs', outfile: at('dist/flickerscope.cjs') });
await build({ ...common, entryPoints: [at('src/global.js')], format: 'iife', minify: true, outfile: at('dist/flickerscope.min.js') });
copyFileSync(at('src/index.d.ts'), at('dist/flickerscope.d.ts'));
copyFileSync(at('src/index.d.ts'), at('dist/flickerscope.d.cts'));
copyFileSync(at('dist/flickerscope.min.js'), at('docs/flickerscope.min.js'));

const sizes = {};
for (const f of ['flickerscope.mjs', 'flickerscope.cjs', 'flickerscope.min.js']) {
  const buf = readFileSync(at('dist/' + f));
  sizes[f] = { bytes: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  console.log(`${f.padEnd(22)} ${String(buf.length).padStart(6)} B   ${String(sizes[f].gzip).padStart(5)} B gzip`);
}
writeFileSync(at('dist/size.json'), JSON.stringify(sizes, null, 2) + '\n');
const minGz = sizes['flickerscope.min.js'].gzip;
if (minGz > 6144) {
  console.error(`min+gzip is ${minGz} B, over the 6 KB budget`);
  process.exit(1);
}
