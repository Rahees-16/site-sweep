# site-sweep

`site-sweep` crawls every reachable page of a website with headless Chromium (Playwright), runs a set of
correctness, SEO and accessibility checks on each page, writes a JSON and Markdown report, and can
optionally file the findings as GitHub issues (dry run by default).

## Responsible use

Only crawl sites you own or have explicit permission to test. The crawler is polite by default
(rate limit, low concurrency, robots.txt respected), never submits forms, never clicks buttons and never
sends credentials, but it still generates real traffic and executes the site's JavaScript.

## Install

```sh
npm install
```

Requires Node.js 20+. Playwright needs its Chromium build; if it is not installed run
`npx playwright install chromium`. If you already have a Chromium / chrome-headless-shell binary, skip the
download and point at it:

```sh
export SITE_SWEEP_CHROMIUM=/path/to/chrome-headless-shell   # or any Chromium binary
```

## Usage

```sh
node bin/site-sweep.js https://example.com
node bin/site-sweep.js https://example.com --max-pages 100 --max-depth 4 --concurrency 2
node bin/site-sweep.js http://localhost:3000 --no-mobile --screenshot --fail-on medium
node bin/site-sweep.js https://example.com --create-issues acme/website            # dry run
node bin/site-sweep.js https://example.com --create-issues acme/website --yes      # really files issues
```

| Option | Default | Meaning |
|---|---|---|
| `--max-pages N` | 50 | Maximum pages to visit |
| `--max-depth N` | 3 | Maximum link depth from the start URL |
| `--delay-ms N` | 300 | Minimum delay between requests (global rate limit) |
| `--concurrency N` | 2 | Pages crawled in parallel |
| `--ignore-robots` | off | Do not honour robots.txt |
| `--max-external N` | 50 | Cap on external links checked |
| `--link-timeout-ms N` | 5000 | Timeout for link checks |
| `--slow-ms N` | 3000 | Slow-page threshold (load / DOMContentLoaded) |
| `--no-mobile` | off | Skip the 375px overflow check |
| `--screenshot` | off | Save screenshots of pages with high-severity page findings to `site-sweep-out/screenshots/` |
| `--out DIR` | `./site-sweep-out` | Output directory |
| `--fail-on LEVEL` | high | `low`, `medium`, `high` or `none` |
| `--create-issues OWNER/REPO` | | Prepare GitHub issues (dry run unless `--yes`) |
| `--yes` | off | Actually create the issues |
| `--max-issues N` | 20 | Cap on issues per run |

Exit codes: `0` no findings at or above `--fail-on`, `1` findings at or above it, `2` usage or crawl error.

## How the crawl works

Same-origin breadth-first search from the start URL, following `<a href>` links (normalized, fragments
stripped, deduplicated). `sitemap.xml` (and `Sitemap:` entries in robots.txt) seed extra pages.
Non-HTML targets (pdf, images, archives, ...) are not crawled but are link-checked. Form submission is
neutralised in the page and any non-GET request is aborted.

## Checks

Each finding has a type, severity (high/medium/low), page URL, selector and snippet, message and a stable fingerprint.

- `http-status` - page returned 4xx/5xx or failed to load (high)
- `console-error` / `console-warning` - browser console messages
- `page-error` - uncaught page exceptions (high)
- `request-failed` - network-level request failures
- `subresource-error` - subresources returning 4xx (medium) / 5xx (high)
- `broken-link` - internal (high) and external (medium) links returning errors
- `unverified-link` - external links that timed out or refused bots (low); checked with HEAD, then GET
- `missing-title`, `missing-meta-description`, `h1-missing`, `h1-multiple`, `missing-lang`
- `missing-alt` - images without an `alt` attribute
- `missing-label` - form controls without a label
- `duplicate-id` - duplicate element ids
- `mixed-content` - http resources on https pages
- `a11y` - axe-core WCAG 2.x A/AA violations (critical/serious = high, moderate = medium, minor = low)
- `slow-page` - load or DOMContentLoaded over `--slow-ms`
- `mobile-overflow` - horizontal overflow at a 375px viewport

## Reports

`site-sweep-out/report.json` (machine readable) and `site-sweep-out/report.md` (summary tables by severity
and type, then findings grouped by page).

## Issue creation safety model

Requires the [GitHub CLI](https://cli.github.com/) (`gh`), authenticated.

- Default is a dry run: each issue (title, labels, body) is printed and nothing is created. In dry-run mode
  `gh` is not invoked at all.
- Real creation needs both `--create-issues OWNER/REPO` and `--yes`.
- Findings are grouped into one issue per (type, severity), listing the affected pages.
- Each issue carries a hidden marker (`<!-- site-sweep-fp:... -->`); before creating, open issues in the repo
  are searched for it and duplicates are skipped.
- `--max-issues` (default 20) caps issues per run, highest severity first.
- Labels `site-sweep` and `severity:<level>` are created only if missing, and only on real creation.
- All `gh` calls go through `src/gh.js`, which tests replace with a fake runner.

## Tests

```sh
npm test
```

Tests start a local fixture website with planted bugs (no external network) and a fake `gh` runner.
Chromium is launched once per crawl; tests run with concurrency 1.

## Known limitations

- Pages that need login or user interaction to reveal links are not explored.
- Link text is not analysed; single-page-app routes without `<a href>` are not discovered.
- Some sites block bots on link checks; those appear as `unverified-link`.

## License

MIT, see [LICENSE](LICENSE).
