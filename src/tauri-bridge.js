// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

// Tauri version of the bridge in preload.js. app.js uses the same interface.
const T = window.__TAURI__;
const { invoke, convertFileSrc } = T.core;
const current = T.webviewWindow.getCurrentWebviewWindow();
const pending = [];

// Listen only to events sent to this window.
const on = (event, cb) => pending.push(current.listen(event, (e) => cb(e.payload)));

const ua = navigator.userAgent;
const platform = /Mac/i.test(ua) ? 'darwin' : /Windows/i.test(ua) ? 'win32' : 'linux';

function fileUrlToPath(href) {
  let p = decodeURIComponent(new URL(href).pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows drive letter
  return p;
}

window.parchment = {
  platform,
  onFile: (cb) => on('file', cb),
  onError: (cb) => on('file-error', cb),
  onFind: (cb) => on('find', cb),
  onDrag: (cb) => on('drag', cb),
  openDialog: () => invoke('open_dialog'),
  openDropped: (paths) => invoke('open_dropped', { paths }),
  openLink: (href) => invoke('open_link', { href }),
  copy: (text) => invoke('copy_text', { text }),
  pathForFile: () => null, // Tauri sends dropped paths to the main process
  // The page cannot load file: URLs. The asset protocol serves local images.
  resolveSrc: (href) => (href.startsWith('file:') ? convertFileSrc(fileUrlToPath(href)) : href),
};

// app.js defines parchmentApplyTheme. Theme events arrive after the page is ready.
on('theme', (mode) => window.parchmentApplyTheme && window.parchmentApplyTheme(mode));

/** Tell the main process the listeners exist. Queued files arrive after this. */
export async function signalReady() {
  await Promise.all(pending);
  await invoke('ready');
}
