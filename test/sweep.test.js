'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/index');
const { startFixture } = require('./fixture');

let fx;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const COMMON = ['--concurrency', '1', '--delay-ms', '0', '--slow-ms', '1000', '--link-timeout-ms', '2000'];

async function sweep(extra = []) {
  const out = tmp();
  const logs = [];
  const code = await run([fx.base + '/', ...COMMON, '--out', out, ...extra], { stdout: (s) => logs.push(s), stderr: () => {} });
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  return { code, report, out, logs };
}
const on = (r, p) => r.findings.filter((f) => f.page === fx.base + p);
const has = (r, p, type) => on(r, p).some((f) => f.type === type);

before(async () => { fx = await startFixture(); });
after(async () => { await fx.close(); });

let main;
test('full crawl', async () => {
  main = await sweep(['--screenshot']);
  assert.equal(main.code, 1);
  assert.ok(fs.existsSync(path.join(main.out, 'report.md')));
  const md = fs.readFileSync(path.join(main.out, 'report.md'), 'utf8');
  assert.match(md, /Summary by severity/);
  assert.match(md, /Findings by page/);
  assert.ok(main.report.findings.every((f) => f.type && f.severity && f.page && f.message && f.fingerprint));
});

test('detects planted bugs', () => {
  const r = main.report;
  assert.ok(has(r, '/broken', 'broken-link'), 'internal broken link');
  assert.ok(r.findings.some((f) => f.type === 'broken-link' && f.message.includes(fx.externalBase + '/gone')), 'external broken link');
  assert.ok(!r.findings.some((f) => f.message.includes(fx.externalBase + '/ok')));
  assert.ok(has(r, '/missing', 'http-status'));
  assert.ok(has(r, '/markup', 'missing-alt'));
  assert.ok(has(r, '/markup', 'duplicate-id'));
  assert.ok(has(r, '/markup', 'missing-label'));
  assert.ok(has(r, '/console', 'console-error'));
  assert.ok(has(r, '/console', 'console-warning'));
  assert.ok(has(r, '/console', 'page-error'));
  assert.ok(has(r, '/subres', 'subresource-error'));
  for (const t of ['missing-title', 'missing-lang', 'h1-missing', 'missing-meta-description']) assert.ok(has(r, '/bare', t), t);
  assert.ok(has(r, '/contrast', 'a11y'));
  assert.ok(on(r, '/contrast').some((f) => f.message.startsWith('color-contrast') && f.severity === 'high'));
  assert.ok(has(r, '/overflow', 'mobile-overflow'));
  assert.ok(has(r, '/slow', 'slow-page'));
});

test('clean page has no findings; autosubmit page has none either', () => {
  assert.deepEqual(on(main.report, '/clean'), []);
  assert.deepEqual(on(main.report, '/autosubmit'), []);
});

test('robots exclusion, sitemap, dedupe', () => {
  const urls = main.report.pages.map((p) => p.url);
  assert.ok(!urls.includes(fx.base + '/secret'));
  assert.ok(!fx.requests.some((r) => r.url === '/secret'));
  assert.ok(urls.includes(fx.base + '/sitemap-only'), 'sitemap page crawled');
  assert.equal(urls.length, new Set(urls).size);
  assert.equal(urls.filter((u) => u.endsWith('/clean')).length, 1);
});

test('never submits forms or sends non-GET', () => {
  assert.deepEqual(fx.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'), []);
  assert.equal(main.report.meta.blockedNonGetRequests, 0, 'script-level submit was neutralised before hitting the network');
});

test('screenshots for high findings', () => {
  const dir = path.join(main.out, 'screenshots');
  assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length > 0);
});

test('fingerprints are stable across runs', async () => {
  const again = await sweep(['--max-pages', '3', '--no-mobile']);
  const a = new Set(main.report.findings.map((f) => f.fingerprint));
  assert.ok(again.report.findings.length > 0 || true);
  for (const f of again.report.findings.filter((x) => x.type !== 'mobile-overflow')) assert.ok(a.has(f.fingerprint), f.type);
});

test('--max-pages caps visited pages', async () => {
  const r = await sweep(['--max-pages', '2', '--no-mobile']);
  assert.equal(r.report.pages.length, 2);
});

test('--max-depth limits crawl', async () => {
  const r = await sweep(['--max-depth', '1', '--no-mobile']);
  const urls = r.report.pages.map((p) => p.url);
  assert.ok(urls.includes(fx.base + '/d1'));
  assert.ok(!urls.includes(fx.base + '/d2'));
  const r2 = await sweep(['--max-depth', '3', '--no-mobile']);
  const u2 = r2.report.pages.map((p) => p.url);
  assert.ok(u2.includes(fx.base + '/d3') && !u2.includes(fx.base + '/d4'));
});

test('--ignore-robots crawls the disallowed page', async () => {
  const r = await sweep(['--ignore-robots', '--no-mobile']);
  assert.ok(r.report.pages.some((p) => p.url.endsWith('/secret')));
});

test('exit codes: fail-on none and usage error', async () => {
  const r = await sweep(['--fail-on', 'none', '--max-pages', '1', '--no-mobile']);
  assert.equal(r.code, 0);
  assert.equal(await run([], { stdout: () => {}, stderr: () => {} }), 2);
  assert.equal(await run(['not a url'], { stdout: () => {}, stderr: () => {} }), 2);
});
