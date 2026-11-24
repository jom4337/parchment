// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

/*
 * Find in the open document.
 * The search runs on the visible text, so a match can cross bold, links, and syntax colors.
 * The CSS Custom Highlight API draws the matches without changes to the document. An engine
 * without it gets boxes on the current match only.
 */

const MAX_MATCHES = 10000;
const SEP = '\u0000'; // between blocks, so that no match crosses them. Documents never contain it.
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,td,th,caption,pre,blockquote,dt,dd,summary,details,div,section,article,figure,figcaption,ul,ol,dl,table,main';
const DUPLICATE_MS = 80;

const $ = (id) => document.getElementById(id);

/** The visible text as one string, and where each text node starts in it. */
function buildIndex(root) {
  const nodes = [];
  const starts = [];
  const parts = [];
  let length = 0;
  let lastBlock = null;
  const add = (s) => {
    parts.push(s);
    length += s.length;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE && n.classList.contains('codeblock-head')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.tagName === 'BR') add('\n');
      continue;
    }
    if (!n.data) continue;
    const block = n.parentElement.closest(BLOCKS);
    if (block !== lastBlock) add(SEP);
    lastBlock = block;
    nodes.push(n);
    starts.push(length);
    add(n.data);
  }
  return { text: parts.join(''), nodes, starts };
}

/** The last text node that starts at or before this offset. */
function nodeAt(index, offset) {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function makeRange(index, { start, end }) {
  const a = nodeAt(index, start);
  const b = nodeAt(index, end - 1);
  const range = document.createRange();
  const clamp = (i, o) => Math.min(index.nodes[i].data.length, o - index.starts[i]);
  range.setStart(index.nodes[a], clamp(a, start));
  range.setEnd(index.nodes[b], clamp(b, end));
  return range;
}

/** A space in the query matches any run of white space, such as a line break in a paragraph. */
function makePattern(query, matchCase) {
  const source = query
    .split(/\s+/)
    .map((s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(source, matchCase ? 'gu' : 'giu');
}

export function createFind(docEl) {
  const panel = $('find');
  const input = $('find-input');
  const count = $('find-count');
  const caseBtn = $('find-case');
  const canHighlight = typeof Highlight === 'function' && Boolean(window.CSS && CSS.highlights);

  let index = null;
  let matches = []; // {start, end, range}
  let capped = false;
  let current = -1;
  let timer = 0;
  let boxes = null;
  let lastStep = { time: -Infinity, source: '', delta: 0 };

  const isOpen = () => !panel.hidden;
  const available = () => !docEl.hidden;

  function clearMarks() {
    if (canHighlight) {
      CSS.highlights.delete('find');
      CSS.highlights.delete('find-current');
    }
    if (boxes) boxes.replaceChildren();
  }

  function drawBoxes() {
    if (canHighlight || !boxes) return;
    boxes.replaceChildren();
    if (current < 0) return;
    for (const r of matches[current].range.getClientRects()) {
      const box = document.createElement('div');
      box.className = 'find-box';
      box.style.left = `${r.left + window.scrollX}px`;
      box.style.top = `${r.top + window.scrollY}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      boxes.append(box);
    }
  }

  function drawCurrent() {
    if (!canHighlight) return drawBoxes();
    if (current < 0) return CSS.highlights.delete('find-current');
    const h = new Highlight(matches[current].range);
    h.priority = 1;
    CSS.highlights.set('find-current', h);
  }

  function drawAll() {
    if (canHighlight) {
      const h = new Highlight();
      for (const m of matches) h.add(m.range);
      CSS.highlights.set('find', h);
    }
    drawCurrent();
  }

  function updateCount() {
    const none = !matches.length;
    const empty = !input.value.trim();
    const total = `${matches.length}${capped ? '+' : ''}`;
    count.textContent = empty ? '' : none ? 'No matches' : `${current + 1} of ${total}`;
    panel.classList.toggle('none', none && !empty);
    $('find-prev').disabled = none;
    $('find-next').disabled = none;
  }

  /** Scroll the page, and any code block or table around the match, to show the match. */
  function reveal() {
    if (current < 0) return;
    const { range } = matches[current];
    const start = range.startContainer.parentElement;
    for (let d = start.closest('details'); d; d = d.parentElement.closest('details')) {
      // The summary of a closed details element is already visible.
      if (!start.closest('summary') || start.closest('summary').parentElement !== d) d.open = true;
    }
    const scroller = start.closest('.codeblock pre, .table-wrap');
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const r = range.getClientRects()[0] || range.getBoundingClientRect();
      if (r.left < box.left + 8 || r.right > box.right - 8) {
        scroller.scrollLeft += r.left - box.left - Math.max(16, (box.width - r.width) / 3);
      }
    }
    const r = range.getClientRects()[0] || range.getBoundingClientRect();
    const top = panel.getBoundingClientRect().bottom + 8;
    if (r.top < top || r.bottom > window.innerHeight - 24) {
      window.scrollTo(window.scrollX, window.scrollY + r.top - Math.max(top, window.innerHeight * 0.3));
    }
  }

  /** @param {number|null} from text offset to start at. null means the top of the view. */
  function search(from, scroll) {
    clearTimeout(timer);
    timer = 0;
    clearMarks();
    matches = [];
    capped = false;
    current = -1;
    const query = input.value;
    if (available() && query.trim()) {
      if (!index) index = buildIndex(docEl);
      for (const m of index.text.matchAll(makePattern(query, caseBtn.getAttribute('aria-pressed') === 'true'))) {
        if (matches.length === MAX_MATCHES) {
          capped = true;
          break;
        }
        const match = { start: m.index, end: m.index + m[0].length };
        match.range = makeRange(index, match);
        matches.push(match);
      }
      if (matches.length) {
        const top = $('bar').getBoundingClientRect().bottom;
        const at = from === null
          ? matches.findIndex((m) => {
              const r = m.range.getBoundingClientRect();
              return (r.width || r.height) && r.bottom > top;
            })
          : matches.findIndex((m) => m.start >= from);
        current = Math.max(0, at);
        drawAll();
        if (scroll) {
          reveal();
          drawBoxes();
        }
      }
    }
    updateCount();
  }

  const anchor = () => (current >= 0 ? matches[current].start : null);

  function open() {
    if (!available()) return;
    const wasOpen = isOpen();
    if (!wasOpen) {
      // Find the selected words, as in other readers.
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed && docEl.contains(sel.anchorNode) ? sel.toString().trim() : '';
      if (text && text.length <= 200 && !/[\r\n]/.test(text)) input.value = text;
      panel.hidden = false;
      if (!canHighlight && !boxes) {
        boxes = document.createElement('div');
        boxes.id = 'find-boxes';
        document.body.append(boxes);
      }
    }
    input.focus({ preventScroll: true });
    input.select();
    if (!wasOpen) search(null, true);
  }

  function close() {
    if (!isOpen()) return;
    clearTimeout(timer);
    timer = 0;
    const range = current >= 0 ? matches[current].range : null;
    clearMarks();
    panel.hidden = true;
    matches = [];
    current = -1;
    input.blur();
    // Leave the match selected, ready to copy.
    if (range && available() && range.startContainer.isConnected) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /** The desktop menu and the page can both get one key press. Use it once. */
  function step(delta, source) {
    if (!available()) return;
    const time = performance.now();
    if (source === 'key' || source === 'menu') {
      const duplicate =
        source !== lastStep.source && delta === lastStep.delta && time - lastStep.time < DUPLICATE_MS;
      lastStep = { time: duplicate ? -Infinity : time, source, delta };
      if (duplicate) return;
    }
    if (!isOpen()) return open();
    if (timer) return search(anchor(), true);
    if (!matches.length) return;
    current = (current + delta + matches.length) % matches.length;
    reveal();
    drawCurrent();
    updateCount();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(anchor(), true), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1, 'enter');
  });
  $('find-prev').addEventListener('click', () => step(-1, 'button'));
  $('find-next').addEventListener('click', () => step(1, 'button'));
  $('find-close').addEventListener('click', close);
  caseBtn.addEventListener('click', () => {
    caseBtn.setAttribute('aria-pressed', String(caseBtn.getAttribute('aria-pressed') !== 'true'));
    search(anchor(), true);
  });

  window.addEventListener('keydown', (e) => {
    if (!available() || e.isComposing) return;
    const key = e.key.toLowerCase();
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (key === 'escape' && isOpen()) {
      e.preventDefault();
      close();
    } else if (mod && !e.shiftKey && key === 'f') {
      // In a browser, a second press gives the browser's own find.
      if (!window.parchment && isOpen() && document.activeElement === input) return;
      e.preventDefault();
      open();
    } else if ((mod && key === 'g') || (key === 'f3' && !mod && !e.altKey)) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1, 'key');
    }
  });

  if (!canHighlight) {
    window.addEventListener('resize', drawBoxes);
    document.addEventListener('scroll', (e) => e.target !== document && drawBoxes(), true);
  }

  return {
    open,
    close,
    next: () => step(1, 'menu'),
    previous: () => step(-1, 'menu'),
    /** The document changed. On a live reload the panel stays open. */
    refresh(reload) {
      const from = anchor();
      index = null;
      if (!isOpen()) return;
      if (reload) search(from === null ? 0 : from, false);
      else close();
    },
  };
}
