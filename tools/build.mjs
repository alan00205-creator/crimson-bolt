#!/usr/bin/env node
// Bundle the game into ONE self-contained HTML file (three.js still comes from jsdelivr via
// the import map). The result opens by double-click (file://) or from any static host.
//
//   node tools/build.mjs                      -> dist/crimson-bolt.html
//   node tools/build.mjs --artifact out.html  -> also write a body-only fragment for hosts that
//                                                wrap pages in their own <html>/<head>/<body>
//
// Needs Node 18+. esbuild is fetched through npx on first run; set ESBUILD=/path/to/esbuild to
// use a local binary instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const artifactOut = args.includes('--artifact') ? path.resolve(args[args.indexOf('--artifact') + 1]) : null;

const esbuildArgs = ['js/main.js', '--bundle', '--format=esm', '--minify', '--target=es2020', '--legal-comments=none',
  '--external:three', '--external:three/addons/*', '--log-level=warning'];
const [cmd, pre] = process.env.ESBUILD ? [process.env.ESBUILD, []] : ['npx', ['--yes', 'esbuild@0.24.2']];
const bundle = execFileSync(cmd, [...pre, ...esbuildArgs], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tag = '<script type="module" src="js/main.js"></script>';
if (!html.includes(tag)) throw new Error('index.html: module script tag not found');
const safe = bundle.replace(/<\/script/gi, '<\\/script');
const out = html.replace(tag, () => `<script type="module">\n${safe}</script>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const dest = path.join(root, 'dist', 'crimson-bolt.html');
fs.writeFileSync(dest, out);
console.log(`wrote ${path.relative(root, dest)} (${(out.length / 1024).toFixed(1)} KB)`);

if (artifactOut) {
  // Body-only fragment: drop the document wrapper; keep <title>, <meta>, <link>, <style>, scripts.
  const frag = out
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
    .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*/i, '');
  fs.writeFileSync(artifactOut, frag);
  console.log(`wrote ${artifactOut} (${(frag.length / 1024).toFixed(1)} KB)`);
}
