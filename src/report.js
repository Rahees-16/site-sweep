'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SEVERITIES } = require('./util');

function summarize(findings) {
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byType = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    byType[f.type] = byType[f.type] || { high: 0, medium: 0, low: 0, total: 0 };
    byType[f.type][f.severity]++;
    byType[f.type].total++;
  }
  return { total: findings.length, bySeverity, byType };
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function toMarkdown(report) {
  const { meta, summary, findings, pages } = report;
  const L = [];
  L.push('# site-sweep report', '');
  L.push(`- Start URL: ${meta.startUrl}`, `- Pages crawled: ${pages.length}`, `- Findings: ${summary.total}`, `- Generated: ${meta.finishedAt}`, '');
  L.push('## Summary by severity', '', '| Severity | Count |', '|---|---|');
  for (const s of [...SEVERITIES].reverse()) L.push(`| ${s} | ${summary.bySeverity[s]} |`);
  L.push('', '## Summary by type', '', '| Type | High | Medium | Low | Total |', '|---|---|---|---|---|');
  for (const [t, c] of Object.entries(summary.byType).sort())
    L.push(`| ${t} | ${c.high} | ${c.medium} | ${c.low} | ${c.total} |`);
  L.push('', '## Findings by page', '');
  const byPage = new Map();
  for (const f of findings) {
    if (!byPage.has(f.page)) byPage.set(f.page, []);
    byPage.get(f.page).push(f);
  }
  if (!byPage.size) L.push('No findings.');
  for (const [p, fs_] of [...byPage].sort()) {
    L.push(`### ${p}`, '');
    for (const f of fs_) {
      L.push(`- **${f.severity}** \`${f.type}\` - ${esc(f.message)}` + (f.selector ? ` (\`${esc(f.selector)}\`)` : ''));
      if (f.snippet) L.push(`  - \`${esc(f.snippet).replace(/`/g, "'")}\``);
      L.push(`  - fingerprint: ${f.fingerprint}`);
    }
    L.push('');
  }
  return L.join('\n');
}

function writeReports(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  const j = path.join(outDir, 'report.json');
  const m = path.join(outDir, 'report.md');
  fs.writeFileSync(j, JSON.stringify(report, null, 2));
  fs.writeFileSync(m, toMarkdown(report));
  return { json: j, md: m };
}

module.exports = { summarize, toMarkdown, writeReports };
