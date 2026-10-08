'use strict';
// The only module that talks to the `gh` CLI. Tests inject a fake runner:
//   runner(args: string[]) => { status: number, stdout: string, stderr: string }
const { spawnSync } = require('node:child_process');

function defaultRunner(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error && r.error.message) || '' };
}

function createGh(runner = defaultRunner) {
  const run = (args) => {
    const r = runner(args);
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || '').trim()}`);
    return r.stdout;
  };
  return {
    findOpenIssueWithMarker(repo, marker, token) {
      const out = run(['issue', 'list', '--repo', repo, '--state', 'open', '--search', token, '--json', 'number,title,body', '--limit', '30']);
      let arr = [];
      try {
        arr = JSON.parse(out || '[]');
      } catch {
        arr = [];
      }
      return arr.find((i) => (i.body || '').includes(marker)) || null;
    },
    listLabels(repo) {
      const out = run(['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name']);
      try {
        return JSON.parse(out || '[]').map((l) => l.name);
      } catch {
        return [];
      }
    },
    createLabel(repo, name, color, description) {
      run(['label', 'create', name, '--repo', repo, '--color', color, '--description', description]);
    },
    createIssue(repo, { title, body, labels }) {
      const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
      for (const l of labels) args.push('--label', l);
      return run(args).trim();
    },
  };
}

module.exports = { createGh, defaultRunner };
