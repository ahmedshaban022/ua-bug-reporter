// Unit tests: pure report logic from shared/reportcore.js — request
// failure classification, storage sizing, env-key extraction, markdown
// generation, and history eviction. Run: node test/run-tests.js
'use strict';

const path = require('node:path');

const R = require(path.join(__dirname, '..', 'shared', 'reportcore.js'));

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
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const ORIGIN = 'https://app.example';

// ---------- failedRequests ----------
const entries = [
  { name: ORIGIN + '/api/projects', initiatorType: 'fetch', duration: 120, transferSize: 512, responseStatus: 200 },
  { name: ORIGIN + '/api/missing', initiatorType: 'fetch', duration: 40, transferSize: 128, responseStatus: 404 },
  { name: ORIGIN + '/api/boom', initiatorType: 'xmlhttprequest', duration: 60, transferSize: 256, responseStatus: 500 },
  { name: ORIGIN + '/img/net-fail', initiatorType: 'fetch', duration: 30, transferSize: 0, responseStatus: 0 },
  { name: 'https://cdn.example/lib.js', initiatorType: 'script', duration: 90, transferSize: 0, responseStatus: undefined },
  { name: ORIGIN + '/api/opaque', initiatorType: 'fetch', duration: 55, transferSize: 0, responseStatus: undefined },
  { name: 'https://cdn.example/pixel', initiatorType: 'img', duration: 10, transferSize: 0, responseStatus: undefined }
];
const failed = R.failedRequests(entries, ORIGIN);
eq('requests: count', failed.length, 4);
check('requests: 404 kept', failed.some((f) => f.status === '404' && f.url.includes('/api/missing')));
check('requests: 500 kept', failed.some((f) => f.status === '500'));
check('requests: status 0 kept', failed.some((f) => f.status === '0'));
check('requests: same-origin opaque fallback kept', failed.some((f) => f.status === '?' && f.url.includes('/api/opaque')));
check('requests: cross-origin opaque dropped', !failed.some((f) => f.url.includes('cdn.example')));
check('requests: img initiator dropped', !failed.some((f) => f.url.includes('/pixel')));
check('requests: sorted by url', failed[0].url <= failed[failed.length - 1].url);
eq('requests: ok entry has fields', failed[0].type && typeof failed[0].ms === 'number' ? 'ok' : 'bad', 'ok');
eq('requests: null list', R.failedRequests(null, ORIGIN).length, 0);
eq('requests: junk entries skipped', R.failedRequests([null, {}, { name: 'x' }], ORIGIN).length, 0);

// ---------- bytesOf ----------
class FakeStorage {
  constructor(seed) {
    this.m = new Map(Object.entries(seed || {}));
  }
  get length() {
    return this.m.size;
  }
  key(i) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
}
eq('bytes: empty', R.bytesOf(new FakeStorage()), 0);
eq('bytes: utf-16 doubled', R.bytesOf(new FakeStorage({ ab: 'cd' })), 8);
eq('bytes: null store', R.bytesOf(null), 0);

// ---------- envKeys ----------
const pairs = [
  ['build', '2026.10.08-4f2a'],
  ['release', 'v3.14.1'],
  ['flag_newUi', 'true'],
  ['theme', 'dark'],
  ['x'.repeat(300), 'y'.repeat(500)]
];
const env = R.envKeys(pairs, R.DEFAULT_ENV_PREFIXES);
eq('env: matched count', env.length, 3);
check('env: exact key matched', env.some(([k]) => k === 'build'));
check('env: prefix matched', env.some(([k]) => k === 'flag_newUi'));
check('env: non-matching skipped', !env.some(([k]) => k === 'theme'));
check('env: long value truncated', env.every(([, v]) => v.length <= R.MAX_TEXT ? v.length <= 120 : false) || env.every(([, v]) => v.length <= 120));
eq('env: null pairs', R.envKeys(null, []).length, 0);

// ---------- truncate / fmtBytes ----------
eq('truncate: short kept', R.truncate('hello', 10), 'hello');
eq('truncate: long cut', R.truncate('hello world', 8), 'hello w…');
eq('truncate: null safe', R.truncate(null, 5), '');
eq('fmt: bytes', R.fmtBytes(512), '512 B');
eq('fmt: zero', R.fmtBytes(0), '0 B');
eq('fmt: kilo', R.fmtBytes(2048), '2.0 KB');
eq('fmt: mega', R.fmtBytes(3 * 1024 * 1024), '3.0 MB');
eq('fmt: junk', R.fmtBytes(NaN), '?');

// ---------- buildMarkdown ----------
const md = R.buildMarkdown({
  title: 'UA Projects — Finance',
  url: 'https://app.example/projects/42?tab=finance',
  time: '2026-10-08T09:00:00.000Z',
  viewportWidth: 1440,
  viewportHeight: 900,
  userAgent: 'Mozilla/5.0 TestChrome/141',
  language: 'en',
  dir: 'ltr',
  connection: '4g',
  pageOrigin: ORIGIN,
  storagePairs: pairs,
  envPrefixes: R.DEFAULT_ENV_PREFIXES,
  storage: true,
  lsCount: 5,
  ssCount: 1,
  lsBytes: 2048,
  ssBytes: 64,
  consoleErrors: [{ text: 'Payment widget failed to mount', stack: 'Error: widget crashed\n    at mount (app.js:12)' }],
  consoleWarnings: [{ text: 'deprecated API' }],
  resources: entries,
  screenshot: { width: 1440, height: 900 }
});
check('md: title', md.includes('# Bug report — UA Projects — Finance'));
check('md: url line', md.includes('**URL:** https://app.example/projects/42?tab=finance'));
check('md: viewport+ua', md.includes('1440×900') && md.includes('TestChrome/141'));
check('md: env section', md.includes('## Environment') && md.includes('2026.10.08-4f2a'));
check('md: console errors section', md.includes('## Console errors (1)'));
check('md: error text fenced', md.includes('Payment widget failed to mount'));
check('md: stack included', md.includes('at mount (app.js:12)'));
check('md: warnings section', md.includes('## Console warnings (1)'));
check('md: failed table', md.includes('## Failed requests (4)') && md.includes('| 404 |') && md.includes('/api/missing'));
check('md: storage summary', md.includes('localStorage: 5 keys (~2.0 KB)'));
check('md: steps placeholder', md.includes('## Steps to reproduce'));
check('md: screenshot note', md.includes('1440×900 PNG'));

const mdLean = R.buildMarkdown({
  title: 'Clean',
  url: 'https://app.example/',
  storagePairs: [],
  resources: [],
  consoleErrors: [],
  consoleWarnings: [],
  storage: false,
  screenshot: null
});
check('md: no env when none match', !mdLean.includes('## Environment'));
check('md: no console sections when empty', !mdLean.includes('Console errors'));
check('md: no requests section when clean', !mdLean.includes('Failed requests'));
check('md: no storage when disabled', !mdLean.includes('## Storage'));
check('md: no screenshot note', !mdLean.includes('Screenshot captured'));

// ---------- appendReport (history cap + budget) ----------
const big = (n) => ({ id: 'r' + n, markdown: 'x'.repeat(1024), png: 'y'.repeat(n * 100) });
let list = [];
for (let i = 0; i < 15; i++) list = R.appendReport(list, big(i), Infinity);
eq('history: capped at 10', list.length, 10);
check('history: newest first', list[0].id === 'r14');
list = [];
for (let i = 0; i < 5; i++) list = R.appendReport(list, { id: 'h' + i, markdown: 'x'.repeat(1024 * 1024), png: '' }, 8 * 1024 * 1024);
check('history: budget evicts oldest', list.length < 5 && list[0].id === 'h4', `len=${list.length}`);
eq('history: never drops the last report', R.appendReport([{ markdown: 'x'.repeat(9 * 1024 * 1024) }], { markdown: 'y' }, 1000).length, 1);

console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log('FAIL: ' + f);
  process.exit(1);
}
