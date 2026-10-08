'use strict';
// Runs inside the page. Returns raw items {type, severity, selector, snippet, message}.
/* eslint-disable no-undef */
function domChecks() {
  const out = [];
  const clip = (s, n = 140) => (s.length > n ? s.slice(0, n) + '...' : s).replace(/\s+/g, ' ');
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement && parts.length < 5) {
      let p = n.localName;
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const add = (type, severity, el, message) =>
    out.push({ type, severity, selector: el ? cssPath(el) : '', snippet: el ? clip(el.outerHTML) : '', message });

  const title = document.title.trim();
  if (!title) add('missing-title', 'medium', document.querySelector('title'), 'Page has a missing or empty <title>');
  const md = document.querySelector('meta[name="description" i]');
  if (!md || !(md.getAttribute('content') || '').trim())
    add('missing-meta-description', 'low', md, 'Missing or empty meta description');
  const h1s = document.querySelectorAll('h1');
  const h1Text = [...h1s].filter((h) => h.textContent.trim());
  if (h1Text.length === 0) add('h1-missing', 'medium', h1s[0] || null, 'Page has no <h1> with text');
  else if (h1s.length > 1) add('h1-multiple', 'low', h1s[1], `Page has ${h1s.length} <h1> elements`);
  const lang = (document.documentElement.getAttribute('lang') || '').trim();
  if (!lang) add('missing-lang', 'medium', document.documentElement, 'Missing <html lang> attribute');

  for (const img of document.querySelectorAll('img:not([alt])'))
    add('missing-alt', 'medium', img, 'Image has no alt attribute');

  const ctl = document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea'
  );
  for (const c of ctl) {
    const labelled =
      (c.labels && c.labels.length > 0) ||
      (c.getAttribute('aria-label') || '').trim() ||
      (c.getAttribute('aria-labelledby') || '').trim() ||
      (c.getAttribute('title') || '').trim();
    if (!labelled) add('missing-label', 'medium', c, 'Form control has no associated label');
  }

  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    if (!el.id) continue;
    if (seen.has(el.id)) {
      if (seen.get(el.id) === 1) add('duplicate-id', 'medium', el, `Duplicate id "${el.id}"`);
      seen.set(el.id, seen.get(el.id) + 1);
    } else seen.set(el.id, 1);
  }

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href,
    selector: cssPath(a),
    snippet: clip(a.outerHTML, 100),
  }));
  return { items: out, links };
}

function overflowCheck() {
  const w = window.innerWidth;
  if (document.documentElement.scrollWidth <= w + 1) return null;
  let culprit = null;
  for (const el of document.body.querySelectorAll('*')) {
    if (el.getBoundingClientRect().right > w + 1) {
      culprit = el;
      break;
    }
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    width: w,
    selector: culprit ? culprit.localName + (culprit.id ? '#' + culprit.id : culprit.className ? '.' + String(culprit.className).split(/\s+/)[0] : '') : 'html',
    snippet: culprit ? culprit.outerHTML.replace(/\s+/g, ' ').slice(0, 140) : '',
  };
}

module.exports = { domChecks, overflowCheck };
