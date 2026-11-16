// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

'use strict';
/*
 * Build the app pages.
 *   renderer-tauri/       used by the Tauri app (index.html, app.js, styles.css)
 *   dist/parchment.html   one file, works in any browser, no install
 */
const esbuild = require('esbuild');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const tauriDir = path.join(root, 'renderer-tauri');

// Full license text of each npm package in a bundle. Fails if a package has no license file.
function thirdPartyNotices(metafile) {
  const pkgs = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.replace(/\\/g, '/').match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (m) pkgs.set(m[2], path.resolve(m[1]));
  }
  const parts = [...pkgs.keys()].sort().map((name) => {
    const dir = pkgs.get(name);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
    if (!file) throw new Error(`No license file in ${dir}`);
    const text = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    return `== ${pj.name} ${pj.version}, license ${pj.license} ==\n\n${text}`;
  });
  const body = `Third-party software in this file:\n\n${parts.join('\n\n')}`;
  return `\n<!--\n${body.replace(/--!?>/g, (s) => s.replace('>', '&gt;'))}\n-->\n`;
}

const sha256 = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

async function main() {
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(tauriDir, { recursive: true });

  const js = await esbuild.build({
    entryPoints: [path.join(src, 'app.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome120', 'safari16'],
    legalComments: 'none',
    metafile: true,
    write: false,
  });
  const script = js.outputFiles[0].text;

  const css = await esbuild.transform(fs.readFileSync(path.join(src, 'styles.css'), 'utf8'), {
    loader: 'css',
    minify: true,
    target: ['chrome120', 'safari16'],
  });
  const style = css.code;

  const template = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

  // Standalone build: everything inline. CSP allows only these exact blocks.
  const inlineScript = script.replace(/<\/script/gi, '<\\/script');
  const standaloneCsp = [
    "default-src 'none'",
    `script-src ${sha256(inlineScript)}`,
    `style-src ${sha256(style)}`,
    'img-src data: blob: https:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  fs.writeFileSync(
    path.join(distDir, 'parchment.html'),
    template
      .replace('__CSP__', standaloneCsp)
      .replace('<!--STYLE-->', () => `<style>${style}</style>`)
      .replace('<!--SCRIPT-->', () => `<script>${inlineScript}</script>`)
      + thirdPartyNotices(js.metafile),
  );

  // Tauri build: same page, Tauri bridge. Tauri adds the CSP (src-tauri/tauri.conf.json).
  const tjs = await esbuild.build({
    entryPoints: [path.join(src, 'tauri-entry.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome120', 'safari16'],
    legalComments: 'none',
    write: false,
  });
  fs.writeFileSync(path.join(tauriDir, 'app.js'), tjs.outputFiles[0].text);
  fs.writeFileSync(path.join(tauriDir, 'styles.css'), style);
  fs.writeFileSync(
    path.join(tauriDir, 'index.html'),
    template
      .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<!--STYLE-->', '<link rel="stylesheet" href="styles.css">')
      .replace('<!--SCRIPT-->', '<script src="app.js"></script>'),
  );

  const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
  console.log(`renderer-tauri/app.js  ${kb(path.join(tauriDir, 'app.js'))} KB`);
  console.log(`dist/parchment.html    ${kb(path.join(distDir, 'parchment.html'))} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
