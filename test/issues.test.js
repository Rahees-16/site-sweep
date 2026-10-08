'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processIssues, groupFindings } = require('../src/issues');
const { createGh } = require('../src/gh');
const { makeFinding } = require('../src/util');

const START = 'https://example.com/';
const F = (type, severity, p) => makeFinding({ type, severity, page: 'https://example.com' + p, selector: 'a', message: `${type} on ${p}` });
const findings = [
  F('broken-link', 'high', '/a'), F('broken-link', 'high', '/b'),
  F('a11y', 'high', '/a'), F('missing-alt', 'medium', '/c'), F('missing-lang', 'medium', '/c'), F('h1-multiple', 'low', '/d'),
];

function fakeRunner({ existing = [], labels = ['site-sweep'] } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const k = args.slice(0, 2).join(' ');
    if (k === 'issue list') return { status: 0, stdout: JSON.stringify(existing), stderr: '' };
    if (k === 'label list') return { status: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: '' };
    if (k === 'label create') return { status: 0, stdout: '', stderr: '' };
    if (k === 'issue create') return { status: 0, stdout: `https://example.invalid/issues/${calls.length}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, calls };
}
const opts = (fake, extra) => ({ repo: 'acme/widgets', yes: false, maxIssues: 20, gh: createGh(fake.runner), startUrl: START, command: 'cmd', log: () => {}, ...extra });

test('grouping is one issue per (type, severity) with marker', () => {
  const g = groupFindings(findings, { startUrl: START, command: 'cmd' });
  assert.equal(g.length, 5);
  const bl = g.find((x) => x.type === 'broken-link');
  assert.equal(bl.count, 2);
  assert.ok(bl.body.includes(bl.marker) && bl.marker.startsWith('<!--'));
  assert.deepEqual(bl.labels, ['site-sweep', 'severity:high']);
  assert.ok(bl.body.includes('/a') && bl.body.includes('/b'));
  assert.equal(g[0].severity, 'high');
});

test('dry run makes ZERO gh calls', () => {
  const fake = fakeRunner();
  const out = [];
  const r = processIssues(findings, opts(fake, { log: (s) => out.push(s) }));
  assert.equal(fake.calls.length, 0);
  assert.equal(r.wouldCreate.length, 5);
  assert.equal(r.created.length, 0);
  assert.ok(out.join('\n').includes('DRY RUN'));
});

test('--yes creates grouped issues and missing labels only', () => {
  const fake = fakeRunner({ labels: ['site-sweep', 'severity:high'] });
  const r = processIssues(findings, opts(fake, { yes: true }));
  assert.equal(r.created.length, 5);
  const creates = fake.calls.filter((c) => c[0] === 'issue' && c[1] === 'create');
  assert.equal(creates.length, 5);
  const labelCreates = fake.calls.filter((c) => c[0] === 'label' && c[1] === 'create').map((c) => c[2]).sort();
  assert.deepEqual(labelCreates, ['severity:low', 'severity:medium']);
  assert.ok(creates.every((c) => c.includes('--repo') && c.includes('acme/widgets')));
});

test('existing marker skips duplicates', () => {
  const g = groupFindings(findings, { startUrl: START, command: 'cmd' });
  const dup = g.find((x) => x.type === 'a11y');
  const fake = fakeRunner({ existing: [{ number: 7, title: 't', body: 'x ' + dup.marker }] });
  // fake returns existing for every search; only the one with matching marker counts
  const r = processIssues(findings, opts(fake, { yes: true }));
  assert.equal(r.skippedDuplicates.length, 1);
  assert.equal(r.skippedDuplicates[0].number, 7);
  assert.equal(r.created.length, 4);
});

test('--max-issues caps', () => {
  const fake = fakeRunner();
  const r = processIssues(findings, opts(fake, { yes: true, maxIssues: 2 }));
  assert.equal(r.created.length, 2);
  assert.equal(r.capped, 3);
  assert.equal(fake.calls.filter((c) => c[1] === 'create' && c[0] === 'issue').length, 2);
  assert.ok(r.created.every((c) => c.group.severity === 'high'));
});

test('rejects bad repo', () => {
  assert.throws(() => processIssues(findings, opts(fakeRunner(), { repo: 'nope' })));
});
