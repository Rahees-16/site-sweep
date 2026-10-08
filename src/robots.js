'use strict';

// Minimal robots.txt parser: User-agent groups, Allow/Disallow with * and $, longest match wins.
function parseRobots(text, agent = 'site-sweep') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') sitemaps.push(val);
    else if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
  }
  const a = agent.toLowerCase();
  let group = groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  if (!group) group = groups.find((g) => g.agents.includes('*'));
  const rules = group ? group.rules.filter((r) => r.path) : [];
  const compiled = rules.map((r) => {
    const re = new RegExp(
      '^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')
    );
    return { allow: r.allow, len: r.path.length, re };
  });
  return {
    sitemaps,
    isAllowed(url) {
      const u = new URL(url);
      const p = u.pathname + u.search;
      let best = null;
      for (const r of compiled) {
        if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

const allowAll = { sitemaps: [], isAllowed: () => true };

async function loadRobots(origin, timeoutMs = 5000) {
  try {
    const res = await fetch(origin + '/robots.txt', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return allowAll;
    return parseRobots(await res.text());
  } catch {
    return allowAll;
  }
}

module.exports = { parseRobots, loadRobots, allowAll };
