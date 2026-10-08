'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { normalizeUrl, isNonHtmlUrl, sleep, makeFinding, sevRank } = require('./util');
const { loadRobots, allowAll } = require('./robots');
const { domChecks, overflowCheck } = require('./pagechecks');

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Covered by dedicated checks, disabled in axe to avoid duplicate findings.
const AXE_SKIP = ['image-alt', 'label', 'document-title', 'html-has-lang', 'html-lang-valid', 'duplicate-id', 'duplicate-id-active', 'duplicate-id-aria'];
const IMPACT = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };

async function launch() {
  const o = { headless: true };
  if (process.env.SITE_SWEEP_CHROMIUM) o.executablePath = process.env.SITE_SWEEP_CHROMIUM;
  return chromium.launch(o);
}

async function fetchText(url, ms = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

async function readSitemaps(origin, robots) {
  const urls = new Set();
  const roots = new Set([origin + '/sitemap.xml', ...robots.sitemaps]);
  for (const s of roots) {
    const xml = await fetchText(s);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      for (const l of locs.slice(0, 5)) {
        const sub = await fetchText(l);
        if (sub) for (const m of sub.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) urls.add(m[1]);
      }
    } else locs.forEach((l) => urls.add(l));
  }
  return [...urls];
}

async function checkLink(url, timeoutMs, external) {
  const tryReq = async (method) => {
    const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), credentials: 'omit' });
    if (r.body) r.body.cancel().catch(() => {});
    return r.status;
  };
  try {
    let status;
    try {
      status = await tryReq('HEAD');
      if (status >= 400) status = await tryReq('GET');
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw e;
      status = await tryReq('GET');
    }
    if (status >= 400) {
      if (external && [401, 403, 429, 999].includes(status)) return { state: 'unverified', status };
      return { state: 'broken', status };
    }
    return { state: 'ok', status };
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { state: 'unverified', status: 0, error: 'timeout' };
    return { state: external ? 'unverified' : 'broken', status: 0, error: (e && e.cause && e.cause.code) || (e && e.message) || 'error' };
  }
}

async function crawl(opts, log = () => {}) {
  const start = normalizeUrl(opts.startUrl);
  if (!start) throw new Error(`invalid start URL: ${opts.startUrl}`);
  const origin = new URL(start).origin;
  const robots = opts.ignoreRobots ? allowAll : await loadRobots(origin);
  const findings = [];
  const fpSeen = new Set();
  const addF = (f) => {
    const x = makeFinding(f);
    if (fpSeen.has(x.fingerprint)) return;
    fpSeen.add(x.fingerprint);
    findings.push(x);
    return x;
  };

  const queued = new Set();
  const queue = [];
  const visited = new Map(); // url -> {url,status,depth,loadMs}
  const links = new Map(); // target -> [{source, selector, snippet}]
  const blocked = { nonGet: 0, robots: new Set() };
  const enqueue = (url, depth) => {
    if (!url || queued.has(url)) return;
    if (new URL(url).origin !== origin || isNonHtmlUrl(url)) return;
    if (!robots.isAllowed(url)) {
      blocked.robots.add(url);
      return;
    }
    queued.add(url);
    queue.push({ url, depth });
  };
  enqueue(start, 0);
  for (const u of await readSitemaps(origin, robots)) enqueue(normalizeUrl(u), 1);

  let nextSlot = 0;
  const throttle = async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + opts.delayMs;
    if (slot > now) await sleep(slot - now);
  };

  const browser = await launch();
  let started = 0;
  let active = 0;
  const out = path.join(opts.outDir, 'screenshots');

  async function visit({ url, depth }) {
    await throttle();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false });
    const failedBlocked = new Set();
    await ctx.route('**/*', (route) => {
      const m = route.request().method();
      if (m !== 'GET' && m !== 'HEAD') {
        blocked.nonGet++;
        failedBlocked.add(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    // Never let page scripts submit forms: neutralise submit paths (the route handler above is the backstop).
    await ctx.addInitScript(() => {
      const noop = function () {};
      HTMLFormElement.prototype.submit = noop;
      HTMLFormElement.prototype.requestSubmit = noop;
      window.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    });
    const page = await ctx.newPage();
    const pageFindings = [];
    const add = (f) => {
      const x = addF({ page: url, ...f });
      if (x) pageFindings.push(x);
    };
    const reqUrls = [];
    let mainStatus = 0;
    try {
      page.on('console', (m) => {
        const t = m.type();
        if (t !== 'error' && t !== 'warning') return;
        if (/^Failed to load resource/.test(m.text())) return; // reported via response events
        const loc = m.location();
        add({ type: t === 'error' ? 'console-error' : 'console-warning', severity: t === 'error' ? 'medium' : 'low', selector: loc && loc.url ? `${loc.url}:${loc.lineNumber}` : '', message: m.text().slice(0, 300) });
      });
      page.on('pageerror', (e) => add({ type: 'page-error', severity: 'high', message: String((e && e.message) || e).slice(0, 300) }));
      page.on('request', (r) => reqUrls.push(r.url()));
      page.on('requestfailed', (r) => {
        if (failedBlocked.has(r.url()) || (r.failure() && /ERR_ABORTED/.test(r.failure().errorText))) return;
        add({ type: 'request-failed', severity: 'medium', selector: r.url(), message: `Request failed: ${r.failure() ? r.failure().errorText : 'unknown'}` });
      });
      page.on('response', (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) return;
        if (r.status() >= 400)
          add({ type: 'subresource-error', severity: r.status() >= 500 ? 'high' : 'medium', selector: r.url(), message: `Subresource returned HTTP ${r.status()}` });
      });

      const t0 = Date.now();
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      } catch (e) {
        if (/Download is starting/i.test(e.message)) {
          visited.set(url, { url, status: 200, depth, nonHtml: true });
          return;
        }
        add({ type: 'http-status', severity: 'high', message: `Navigation failed: ${e.message.split('\n')[0]}` });
        visited.set(url, { url, status: 0, depth, error: true });
        return;
      }
      mainStatus = resp ? resp.status() : 0;
      const ct = resp ? resp.headers()['content-type'] || '' : '';
      const finalUrl = normalizeUrl(page.url()) || url;
      const rec = { url, status: mainStatus, depth, loadMs: Date.now() - t0 };
      visited.set(url, rec);
      if (finalUrl !== url) visited.set(finalUrl, rec);
      if (mainStatus >= 400) {
        add({ type: 'http-status', severity: 'high', message: `Page returned HTTP ${mainStatus}` });
        return;
      }
      if (ct && !/html/i.test(ct)) {
        rec.nonHtml = true;
        return;
      }
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const perf = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null;
      }).catch(() => null);
      const slow = Math.max(perf ? perf.dcl : 0, perf ? perf.load : 0);
      rec.loadMs = Math.round(slow || rec.loadMs);
      if (slow > opts.slowMs)
        add({ type: 'slow-page', severity: 'medium', message: `Page took ${Math.round(slow)} ms to load (threshold ${opts.slowMs} ms)` });

      if (url.startsWith('https:'))
        for (const r of new Set(reqUrls.filter((u) => u.startsWith('http:'))))
          add({ type: 'mixed-content', severity: 'medium', selector: r, message: 'Insecure http resource loaded on https page' });

      const dom = await page.evaluate(domChecks);
      for (const it of dom.items) add(it);
      for (const l of dom.links) {
        const t = normalizeUrl(l.href);
        if (!t) continue;
        if (!links.has(t)) links.set(t, []);
        links.get(t).push({ source: url, selector: l.selector, snippet: l.snippet });
        if (depth + 1 <= opts.maxDepth && new URL(t).origin === origin) enqueue(t, depth + 1);
      }

      try {
        const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(AXE_SKIP).analyze();
        for (const v of res.violations)
          for (const n of v.nodes.slice(0, 3))
            add({ type: 'a11y', severity: IMPACT[v.impact] || 'medium', selector: (n.target || []).join(' '), snippet: (n.html || '').slice(0, 140), message: `${v.id}: ${v.help}` });
      } catch (e) {
        log(`axe failed on ${url}: ${e.message}`);
      }

      if (opts.screenshot && pageFindings.some((f) => f.severity === 'high')) {
        fs.mkdirSync(out, { recursive: true });
        const name = (new URL(url).pathname.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'index') + '.png';
        await page.screenshot({ path: path.join(out, name), fullPage: false }).catch(() => {});
      }

      if (opts.mobile) {
        await page.setViewportSize({ width: 375, height: 812 });
        const o = await page.evaluate(overflowCheck).catch(() => null);
        if (o) add({ type: 'mobile-overflow', severity: 'medium', selector: o.selector, snippet: o.snippet, message: `Horizontal overflow at 375px (content ${o.scrollWidth}px wide)` });
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async function worker() {
    for (;;) {
      if (started >= opts.maxPages) return;
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await sleep(40);
        continue;
      }
      started++;
      active++;
      try {
        log(`crawl [${item.depth}] ${item.url}`);
        await visit(item);
      } catch (e) {
        addF({ type: 'http-status', severity: 'high', page: item.url, message: `Crawl error: ${e.message.split('\n')[0]}` });
      } finally {
        active--;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  // Link checking
  let externalChecked = 0;
  let externalSkipped = 0;
  for (const [target, refs] of links) {
    const internal = new URL(target).origin === origin;
    let r;
    const v = visited.get(target);
    if (v && !v.error && v.status) r = { state: v.status >= 400 ? 'broken' : 'ok', status: v.status };
    else if (internal) {
      if (!robots.isAllowed(target)) continue;
      await throttle();
      r = await checkLink(target, opts.linkTimeoutMs, false);
    } else {
      if (externalChecked >= opts.maxExternal) {
        externalSkipped++;
        continue;
      }
      externalChecked++;
      r = await checkLink(target, opts.linkTimeoutMs, true);
    }
    if (r.state === 'ok') continue;
    for (const ref of refs) {
      if (r.state === 'broken')
        addF({ type: 'broken-link', severity: internal ? 'high' : 'medium', page: ref.source, selector: ref.selector, snippet: ref.snippet, message: `${internal ? 'Internal' : 'External'} link ${target} is broken (${r.status || r.error})` });
      else
        addF({ type: 'unverified-link', severity: 'low', page: ref.source, selector: ref.selector, snippet: ref.snippet, message: `External link ${target} could not be verified (${r.status || r.error})` });
    }
  }

  const pages = [...new Set(visited.values())].map((p) => ({ url: p.url, status: p.status, depth: p.depth, loadMs: p.loadMs }));
  findings.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.page.localeCompare(b.page) || a.type.localeCompare(b.type));
  return { pages, findings, meta: { origin, blockedNonGetRequests: blocked.nonGet, robotsExcluded: [...blocked.robots], externalChecked, externalSkipped } };
}

module.exports = { crawl };
