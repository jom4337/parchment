// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

import { renderMarkdown } from './render.js';

// `api` exists in the Tauri app (see tauri-bridge.js). It is null in a plain browser.
const api = window.parchment || null;
// `android` exists in the Android app (android/.../MainActivity.java). It uses the browser build.
const android = (!api && window.ParchmentAndroid) || null;
const MAX_BYTES = 10 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const docEl = $('doc');
const emptyEl = $('empty');
const errorEl = $('error');
const picker = $('picker');

// Detect the OS. userAgentData is the newer API; navigator.platform is the fallback.
function detectMac() {
  if (api) return api.platform === 'darwin';
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  return /mac/i.test(p);
}
const isMac = detectMac();

const bar = $('bar');

function show(which) {
  docEl.hidden = which !== 'doc';
  emptyEl.hidden = which !== 'empty';
  errorEl.hidden = which !== 'error';
  // The browser version has no menu, so the bar holds Theme, Open, and Close.
  bar.hidden = Boolean(api);
  $('bar-close').hidden = which !== 'doc';
  if (which !== 'doc') $('bar-name').textContent = '';
}

// ---- Themes --------------------------------------------------------------
// auto follows the system light or dark setting. The others are fixed.

const THEMES = ['auto', 'light', 'dim', 'dark', 'eink'];
const THEME_KEY = 'parchment.theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = 'auto';

function applyTheme(choice) {
  themeChoice = THEMES.includes(choice) ? choice : 'auto';
  const resolved = themeChoice === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : themeChoice;
  document.documentElement.dataset.theme = resolved;
  $('theme').value = themeChoice;
  // Match the Android status and navigation bars to the page.
  if (android) {
    const bg = getComputedStyle(document.body).backgroundColor;
    android.setChrome(bg, resolved !== 'dark');
  }
}

darkQuery.addEventListener('change', () => applyTheme(themeChoice));

// The desktop apps choose the theme in their menus ("system" means auto).
window.parchmentApplyTheme = (mode) => applyTheme(mode === 'system' ? 'auto' : mode);

if (api) {
  applyTheme('auto');
} else {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can be off for file:// pages. The choice then lasts for this visit.
  }
  applyTheme(saved || 'auto');
  $('theme').addEventListener('change', (e) => {
    applyTheme(e.target.value);
    try {
      localStorage.setItem(THEME_KEY, themeChoice);
    } catch {
      // See above.
    }
  });
}

function closeFile() {
  if (android) android.closed();
  docEl.replaceChildren();
  show('empty');
  document.title = 'Parchment';
  window.scrollTo(0, 0);
}

function showError(message) {
  $('error-msg').textContent = message;
  show('error');
}

function scrollToId(id) {
  if (!id) return false;
  let target = null;
  try {
    target = document.getElementById(decodeURIComponent(id));
  } catch {
    target = document.getElementById(id);
  }
  if (!target) return false;
  target.scrollIntoView();
  return true;
}

function showFile({ content, name, baseUrl = null, hash = '', reason = 'open' }) {
  const keep = window.scrollY;
  docEl.replaceChildren(renderMarkdown(content, { baseUrl, resolveSrc: api && api.resolveSrc }));
  show('doc');
  if (!api) {
    document.title = `${name} - Parchment`;
    $('bar-name').textContent = name;
  }
  // The Android app keeps a copy, so the file comes back after a dark mode switch.
  if (android && reason === 'open') android.opened(name, content);
  if (reason === 'reload') window.scrollTo(0, keep);
  else if (!scrollToId(hash)) window.scrollTo(0, 0);
}

// ---- Opening files -------------------------------------------------------

function openDialog() {
  if (api) api.openDialog();
  else picker.click();
}

async function openBrowserFile(file) {
  if (file.size > MAX_BYTES) return showError('The file is larger than 10 MB.');
  const content = await file.text();
  if (content.includes('\u0000')) return showError('The file is not a text file.');
  showFile({ content, name: file.name });
}

$('open-btn').addEventListener('click', openDialog);
$('error-btn').addEventListener('click', openDialog);
picker.addEventListener('change', async () => {
  const file = picker.files[0];
  picker.value = '';
  if (file) await openBrowserFile(file);
});

$('bar-open').addEventListener('click', openDialog);
$('bar-close').addEventListener('click', closeFile);

if (!api) {
  // The desktop apps handle this shortcut in their menus.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      picker.click();
    }
  });
}

$('hint').textContent = android
  ? 'Tap Open file, or open a .md file from a file manager.'
  : `Drop a file here, or press ${isMac ? '⌘O' : 'Ctrl+O'}.`;

show('empty');

// ---- Drag and drop -------------------------------------------------------

const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  if (api) {
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) api.openDropped(paths);
  } else {
    await openBrowserFile(files[0]);
  }
});

// ---- Clicks inside the document -----------------------------------------

async function copyText(text) {
  if (api) return api.copy(text);
  if (android) return android.copy(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

docEl.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy');
  if (copy) {
    const block = copy.closest('.codeblock');
    copyText(block.dataset.code);
    copy.textContent = 'Copied';
    copy.classList.add('done');
    setTimeout(() => {
      copy.textContent = 'Copy';
      copy.classList.remove('done');
    }, 1500);
    return;
  }

  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    scrollToId(href.slice(1));
  } else if (api) {
    api.openLink(href);
  } else if (/^(https?:|mailto:)/i.test(href)) {
    if (android) android.openExternal(href);
    else window.open(href, '_blank', 'noopener,noreferrer');
  }
});

// ---- Messages from the Tauri main process --------------------------------

if (api) {
  api.onFile(showFile);
  api.onError(showError);
  if (api.onDrag) api.onDrag((on) => document.body.classList.toggle('dragging', Boolean(on)));
}

// ---- Files from the Android app ------------------------------------------
// The app holds a file from Open with, Share, or a restart. The page asks for it
// at start and each time the app comes to the front. No script injection is needed.

function pullAndroid() {
  let raw = '';
  try {
    raw = android.takePending();
  } catch {
    return;
  }
  if (!raw) return;
  const doc = JSON.parse(raw);
  if (doc.error) showError(doc.error);
  else showFile({ content: doc.text, name: doc.name, reason: doc.restore ? 'restore' : 'open' });
}

if (android) {
  window.parchmentAndroidPull = pullAndroid;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullAndroid();
  });
  window.addEventListener('focus', pullAndroid);
  pullAndroid();
}
