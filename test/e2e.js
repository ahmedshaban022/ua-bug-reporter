// End-to-end tests: serves the demo page (which loads the real console
// hook first, exactly as the armed registration would), makes it fail in
// every way a bug report cares about, then runs the real collector and
// markdown builder in the page and asserts the report content.
// Run: NODE_PATH="<workspace>/.devdeps/node_modules" node test/e2e.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(__dirname, 'demo');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (detail ? ` :: ${detail}` : ''));
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function startServer(port) {
  const srv = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    if (route === '/hook.js') {
      res.writeHead(200, { 'content-type': MIME['.js'] });
      res.end(fs.readFileSync(path.join(ROOT, 'content', 'console-hook.js')));
      return;
    }
    if (route === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (route === '/boom') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(fs.readFileSync(path.join(DEMO, 'index.html')));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  const { chromium } = require('playwright-core');
  const PORT = 3781;
  const srv = await startServer(PORT);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/projects/42?tab=finance`, { waitUntil: 'load' });
    await page.waitForTimeout(400); // let the demo fire its errors + failures

    // Load the isolated-world bundle exactly as the extension injects it.
    for (const f of ['shared/reportcore.js', 'content/collect.js']) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }

    // ---------- 1. console hook captured everything planted ----------
    const buf = await page.evaluate(() => window.__uaBugBuffer);
    check('hook: buffer exists', !!buf);
    const errTexts = (buf.errors || []).map((e) => e.text).join('\n');
    check('hook: console.error captured', errTexts.includes('Payment widget failed to mount'));
    check('hook: uncaught throw captured', errTexts.includes('late crash during render'));
    check('hook: stack kept', (buf.errors || []).some((e) => e.stack && e.stack.includes('widget crashed')));
    check('hook: warning captured', (buf.warnings || []).some((w) => w.text === 'localStorage fallback in use'));

    // ---------- 2. collector gathers page facts + failures ----------
    const facts = await page.evaluate(() => window.UABugReporter.collect({ includeStorage: true }));
    check('collect: url', facts.url.includes('/projects/42?tab=finance'));
    check('collect: title', facts.title.includes('Bug reporter demo'));
    check('collect: viewport', facts.viewportWidth === 1280 && facts.viewportHeight === 800);
    check('collect: storage counts', facts.lsCount === 5 && facts.ssCount === 1);
    check('collect: storage bytes', facts.lsBytes > 0 && facts.ssBytes > 0);
    check('collect: pairs include env keys', facts.storagePairs.some(([k]) => k === 'build'));

    // ---------- 3. markdown report end-to-end ----------
    const report = await page.evaluate((f) => {
      const C = window.UAReportCore;
      const b = window.__uaBugBuffer;
      return C.buildMarkdown(
        Object.assign({}, f, {
          time: '2026-10-08T09:00:00.000Z',
          envPrefixes: C.DEFAULT_ENV_PREFIXES,
          consoleErrors: b.errors.slice(-50),
          consoleWarnings: b.warnings.slice(-50),
          screenshot: null
        })
      );
    }, facts);
    check('report: console error present', report.includes('Payment widget failed to mount'));
    check('report: stack fenced', report.includes('at ') && report.includes('widget crashed') ? true : report.includes('widget crashed'));
    check('report: 404 row', /\| 404 \|/.test(report) && report.includes('/missing'));
    check('report: 500 row', /\| 500 \|/.test(report) && report.includes('/boom'));
    check('report: env build id', report.includes('2026.10.08-4f2a9c'));
    check('report: storage summary', /localStorage: 5 keys/.test(report));
    check('report: steps section', report.includes('## Steps to reproduce'));
    check('report: no screenshot note when none', !report.includes('Screenshot captured'));

    // ---------- 4. ring buffer caps at 200 ----------
    await page.evaluate(() => {
      for (let i = 0; i < 260; i++) console.error('spam ' + i);
    });
    const capped = await page.evaluate(() => window.__uaBugBuffer.errors.length);
    eq2('hook: ring capped at 200', capped, 200);
    const lastSpam = await page.evaluate(() => window.__uaBugBuffer.errors[199].text);
    check('hook: newest kept after cap', lastSpam === 'spam 259');

    // ---------- 5. hook wraps once (idempotent) ----------
    await page.addScriptTag({ path: path.join(ROOT, 'content', 'console-hook.js') });
    await page.evaluate(() => console.error('after-reinject'));
    const after = await page.evaluate(() => window.__uaBugBuffer.errors.filter((e) => e.text === 'after-reinject').length);
    eq2('hook: re-inject records once', after, 1);

    console.log(`${pass} passed, ${fail} failed`);
  } finally {
    await browser.close();
    srv.close();
  }
  if (fail) {
    for (const f of failures) console.log('FAIL: ' + f);
    process.exit(1);
  }

  function eq2(name, actual, expected) {
    check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
