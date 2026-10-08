'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/index');
const { startFixture } = require('./fixture');

let fx;
before(async () => { fx = await startFixture(); });
after(async () => { await fx.close(); });

const args = (extra) => [fx.base + '/broken', '--max-pages', '1', '--max-depth', '0', '--concurrency', '1', '--delay-ms', '0', '--no-mobile', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'ssi-')), ...extra];

test('CLI dry run: no gh calls; --yes needs repo; real run uses injected runner', async () => {
  const calls = [];
  const runner = (a) => { calls.push(a); return { status: 0, stdout: a[0] === 'issue' && a[1] === 'create' ? 'https://example.invalid/1' : '[]', stderr: '' }; };
  const logs = [];
  const io = { stdout: (s) => logs.push(s), stderr: () => {}, ghRunner: runner };
  await run(args(['--create-issues', 'acme/widgets']), io);
  assert.equal(calls.length, 0);
  assert.ok(logs.join('\n').includes('Dry run'));
  assert.equal(await run(args(['--yes']), io), 2);
  await run(args(['--create-issues', 'acme/widgets', '--yes']), io);
  assert.ok(calls.some((c) => c[0] === 'issue' && c[1] === 'create'));
});
