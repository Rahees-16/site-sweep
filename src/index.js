'use strict';
const path = require('node:path');
const { parseArgs } = require('node:util');
const { normalizeUrl, sevRank } = require('./util');
const { crawl } = require('./crawler');
const { summarize, writeReports } = require('./report');
const { createGh } = require('./gh');
const { processIssues } = require('./issues');

const HELP = `site-sweep - crawl a site you own and report problems

Usage: site-sweep <startUrl> [options]

Crawl:
  --max-pages N        max pages to visit (default 50)
  --max-depth N        max link depth (default 3)
  --delay-ms N         minimum delay between requests (default 300)
  --concurrency N      parallel pages (default 2)
  --ignore-robots      do not honour robots.txt
  --max-external N     max external links to check (default 50)
  --link-timeout-ms N  timeout for link checks (default 5000)
  --slow-ms N          slow page threshold (default 3000)
  --no-mobile          skip the 375px overflow check
  --screenshot         screenshot pages with high findings
  --out DIR            output dir (default ./site-sweep-out)
  --fail-on LEVEL      low|medium|high|none (default high)
Issues (dry run unless --yes):
  --create-issues OWNER/REPO
  --yes                actually create issues
  --max-issues N       default 20
Exit: 0 ok, 1 findings >= --fail-on, 2 usage/crawl error.
Only crawl sites you own or have permission to test.
`;

const num = (v, d, name) => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-pages': { type: 'string' }, 'max-depth': { type: 'string' }, 'delay-ms': { type: 'string' },
      concurrency: { type: 'string' }, 'ignore-robots': { type: 'boolean' }, 'max-external': { type: 'string' },
      'link-timeout-ms': { type: 'string' }, 'slow-ms': { type: 'string' }, 'no-mobile': { type: 'boolean' },
      screenshot: { type: 'boolean' }, out: { type: 'string' }, 'fail-on': { type: 'string' },
      'create-issues': { type: 'string' }, yes: { type: 'boolean' }, 'max-issues': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error('exactly one <startUrl> is required');
  const startUrl = normalizeUrl(positionals[0]);
  if (!startUrl) throw new Error(`invalid start URL: ${positionals[0]}`);
  const failOn = values['fail-on'] || 'high';
  if (!['low', 'medium', 'high', 'none'].includes(failOn)) throw new Error('--fail-on must be low|medium|high|none');
  if (values.yes && !values['create-issues']) throw new Error('--yes requires --create-issues OWNER/REPO');
  return {
    startUrl,
    maxPages: num(values['max-pages'], 50, 'max-pages'),
    maxDepth: num(values['max-depth'], 3, 'max-depth'),
    delayMs: num(values['delay-ms'], 300, 'delay-ms'),
    concurrency: Math.max(1, num(values.concurrency, 2, 'concurrency')),
    ignoreRobots: !!values['ignore-robots'],
    maxExternal: num(values['max-external'], 50, 'max-external'),
    linkTimeoutMs: num(values['link-timeout-ms'], 5000, 'link-timeout-ms'),
    slowMs: num(values['slow-ms'], 3000, 'slow-ms'),
    mobile: !values['no-mobile'],
    screenshot: !!values.screenshot,
    outDir: path.resolve(values.out || 'site-sweep-out'),
    failOn,
    createIssues: values['create-issues'],
    yes: !!values.yes,
    maxIssues: num(values['max-issues'], 20, 'max-issues'),
  };
}

function reproCommand(o) {
  const a = ['node bin/site-sweep.js', o.startUrl, `--max-pages ${o.maxPages}`, `--max-depth ${o.maxDepth}`];
  if (o.ignoreRobots) a.push('--ignore-robots');
  if (!o.mobile) a.push('--no-mobile');
  if (o.slowMs !== 3000) a.push(`--slow-ms ${o.slowMs}`);
  return a.join(' ');
}

// io: { stdout, stderr, ghRunner }
async function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s + '\n'));
  const stderr = io.stderr || ((s) => process.stderr.write(s + '\n'));
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    stderr(`site-sweep: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    stdout(HELP);
    return 0;
  }
  let result;
  try {
    result = await crawl(o, (m) => stderr(m));
  } catch (e) {
    stderr(`site-sweep: crawl failed: ${e.message}`);
    return 2;
  }
  if (result.pages.length === 0 || result.pages.every((p) => p.error)) {
    stderr('site-sweep: no pages could be crawled (start URL unreachable or excluded by robots.txt)');
    return 2;
  }
  const report = {
    meta: {
      startUrl: o.startUrl,
      finishedAt: new Date().toISOString(),
      options: { ...o, outDir: undefined },
      ...result.meta,
    },
    summary: summarize(result.findings),
    pages: result.pages,
    findings: result.findings,
  };
  const files = writeReports(o.outDir, report);
  stdout(`Crawled ${result.pages.length} page(s); ${result.findings.length} finding(s) (high ${report.summary.bySeverity.high}, medium ${report.summary.bySeverity.medium}, low ${report.summary.bySeverity.low}).`);
  stdout(`Reports: ${files.md} , ${files.json}`);

  let issueResult = null;
  if (o.createIssues) {
    try {
      issueResult = processIssues(result.findings, {
        repo: o.createIssues, yes: o.yes, maxIssues: o.maxIssues,
        gh: createGh(io.ghRunner), startUrl: o.startUrl, command: reproCommand(o), log: stdout,
      });
    } catch (e) {
      stderr(`site-sweep: issue creation failed: ${e.message}`);
      return 2;
    }
    if (!o.yes) stdout(`Dry run: ${issueResult.wouldCreate.length} issue(s) would be created in ${o.createIssues}. Re-run with --yes to create them.`);
    else stdout(`Issues: ${issueResult.created.length} created, ${issueResult.skippedDuplicates.length} duplicate(s) skipped.`);
  }
  run.lastIssueResult = issueResult;
  if (o.failOn === 'none') return 0;
  return result.findings.some((f) => sevRank(f.severity) >= sevRank(o.failOn)) ? 1 : 0;
}

module.exports = { run, parseCli, reproCommand };
