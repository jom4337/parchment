// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('powershell', powershell);

// Fence names that highlight.js does not know by default.
const LANG_ALIAS = {
  jsonc: 'json',
  json5: 'json',
  plsql: 'sql',
  pgsql: 'sql',
  tsql: 'sql',
  zsh: 'bash',
  console: 'bash',
  text: 'plaintext',
  txt: 'plaintext',
};

marked.setOptions({ gfm: true, breaks: false });

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Show YAML front matter as a plain code block instead of hiding it. */
function liftFrontMatter(src) {
  const m = FRONT_MATTER.exec(src);
  if (!m) return src;
  return '~~~~yaml\n' + m[1] + '\n~~~~\n\n' + src.slice(m[0].length);
}

/** GitHub-style heading slug. */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function addHeadingIds(root) {
  const seen = new Map();
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (h.id) continue;
    const base = slugify(h.textContent) || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

function wrapCodeBlocks(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector(':scope > code');
    if (!code) continue;
    const text = code.textContent.replace(/\n$/, '');
    const fence = (/(?:^|\s)language-([^\s]+)/.exec(code.className) || [])[1] || '';
    const name = LANG_ALIAS[fence.toLowerCase()] || fence.toLowerCase();

    if (name && hljs.getLanguage(name)) {
      code.innerHTML = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
      code.className = `hljs language-${name}`;
    } else {
      code.textContent = text;
      code.className = 'hljs';
    }

    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    wrap.dataset.code = text;

    const head = document.createElement('div');
    head.className = 'codeblock-head';
    const label = document.createElement('span');
    label.className = 'codeblock-lang';
    label.textContent = fence || 'text';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = 'Copy';
    head.append(label, btn);

    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

function wrapTables(root) {
  for (const t of root.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  }
}

function markTaskLists(root) {
  for (const input of root.querySelectorAll('input')) {
    if (input.type !== 'checkbox') {
      input.remove();
      continue;
    }
    input.disabled = true;
    const li = input.closest('li');
    if (li) {
      li.classList.add('task');
      li.parentElement.classList.add('contains-tasks');
    }
  }
}

function fixImages(root, baseUrl, resolveSrc) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const relative = src && !SCHEME.test(src) && !src.startsWith('//') && !src.startsWith('/');
    if (relative && !baseUrl) {
      // Browser build: the file location is unknown. Show the alt text.
      const ph = document.createElement('span');
      ph.className = 'img-missing';
      ph.textContent = img.alt ? `[image: ${img.alt}]` : '[image]';
      img.replaceWith(ph);
      continue;
    }
    if (relative) {
      const abs = new URL(src, baseUrl).href;
      img.src = resolveSrc ? resolveSrc(abs) : abs;
    }
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
  }
}

function fixLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) a.rel = 'noopener noreferrer';
  }
}

/**
 * Convert Markdown text to a sanitized, inert DocumentFragment.
 * @param {string} source Markdown text
 * @param {{baseUrl?: string|null, resolveSrc?: Function|null}} opts baseUrl is the file URL of
 *   the document folder. resolveSrc maps a resolved file URL to a URL the page can load.
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, { baseUrl = null, resolveSrc = null } = {}) {
  const text = liftFrontMatter(source.replace(/^﻿/, ''));
  const dirty = marked.parse(text, { async: false });
  const clean = DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'dialog'],
    FORBID_ATTR: ['style'],
  });

  // A template keeps the tree inert. Images do not load until the tree is inserted.
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const root = tpl.content;

  addHeadingIds(root);
  markTaskLists(root);
  fixImages(root, baseUrl, resolveSrc);
  fixLinks(root);
  wrapTables(root);
  wrapCodeBlocks(root);
  return root;
}
