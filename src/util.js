'use strict';
const crypto = require('node:crypto');

const SEVERITIES = ['low', 'medium', 'high'];
const sevRank = (s) => SEVERITIES.indexOf(s);

const NON_HTML_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|ico|bmp|avif|zip|gz|tgz|tar|rar|7z|mp3|mp4|webm|mov|avi|wav|doc|docx|xls|xlsx|ppt|pptx|csv|json|xml|txt|css|js|woff2?|ttf|eot|exe|dmg|apk)$/i;

function normalizeUrl(href, base) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.href;
}

const isNonHtmlUrl = (url) => NON_HTML_EXT.test(new URL(url).pathname);

function fingerprint(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function pageKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname + u.search;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFinding({ type, severity, page, selector = '', snippet = '', message }) {
  return {
    type,
    severity,
    page,
    selector,
    snippet,
    message,
    fingerprint: fingerprint(type, pageKey(page), selector, message),
  };
}

module.exports = { SEVERITIES, sevRank, normalizeUrl, isNonHtmlUrl, fingerprint, sleep, makeFinding, pageKey };
