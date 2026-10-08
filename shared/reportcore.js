// Pure report logic shared by the service worker, report page, and Node
// unit tests (CommonJS) — and by classic content scripts via the global
// UAReportCore. No chrome.* or DOM access lives here.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UAReportCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_TEXT = 400; // per console entry, keeps reports pasteable
  const MAX_URL = 200; // request URLs can be enormous
  const MAX_ENV_VALUE = 120;
  const MAX_REPORTS = 10; // history cap
  const STORAGE_BUDGET = 8 * 1024 * 1024; // bytes of stored reports incl. PNGs

  const DEFAULT_ENV_PREFIXES = ['build', 'release', 'version', 'env', 'flag_'];

  // ---------- resource timing ----------

  // Classify PerformanceResourceTiming-like entries into failures.
  // Primary signal: responseStatus (same-origin / TAO-allowed, Chrome 109+).
  // Fallback for statusless entries: only same-origin fetch/xhr/beacon that
  // transferred nothing but took time — cross-origin entries without
  // Timing-Allow-Origin would otherwise false-positive.
  function failedRequests(entries, pageOrigin) {
    const out = [];
    for (const e of entries || []) {
      if (!e || typeof e.name !== 'string') continue;
      const sameOrigin = !pageOrigin || e.name.indexOf(pageOrigin + '/') === 0 || e.name === pageOrigin;
      const status = typeof e.responseStatus === 'number' ? e.responseStatus : undefined;
      let failed = false;
      if (status !== undefined) {
        failed = status >= 400 || status === 0;
      } else if (sameOrigin && (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'beacon')) {
        failed = e.transferSize === 0 && e.duration > 0;
      }
      if (!failed) continue;
      out.push({
        status: status === undefined ? '?' : String(status),
        type: e.initiatorType || 'other',
        url: truncate(e.name, MAX_URL),
        ms: Math.round(e.duration || 0)
      });
    }
    out.sort((a, b) => a.url.localeCompare(b.url));
    return out;
  }

  // ---------- storage/env ----------

  function bytesOf(store) {
    let total = 0;
    for (let i = 0; store && i < store.length; i++) {
      const k = store.key(i) || '';
      const v = store.getItem(k) || '';
      total += k.length + v.length;
    }
    return total * 2; // UTF-16 code units ≈ 2 bytes
  }

  function envKeys(pairs, prefixes) {
    const ps = (prefixes || DEFAULT_ENV_PREFIXES).filter((p) => typeof p === 'string' && p !== '');
    const out = [];
    for (const [k, v] of pairs || []) {
      if (!ps.some((p) => k === p || k.startsWith(p))) continue;
      out.push([k, truncate(String(v), MAX_ENV_VALUE)]);
      if (out.length >= 20) break; // env blocks stay a summary, not a dump
    }
    return out;
  }

  // ---------- formatting ----------

  function truncate(s, n) {
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function entryLines(list, label) {
    if (!list || !list.length) return [];
    const lines = [`## ${label} (${list.length})`, ''];
    for (const item of list) {
      const text = truncate(item.text, MAX_TEXT);
      const stack = item.stack ? '\n' + truncate(item.stack, 800) : '';
      lines.push('```');
      lines.push(text + stack);
      lines.push('```');
    }
    return lines;
  }

  function buildMarkdown(d) {
    const lines = [];
    lines.push(`# Bug report — ${truncate(d.title || 'page', 120)}`);
    lines.push('');
    lines.push(`**URL:** ${d.url || ''}`);
    lines.push(`**Time:** ${d.time || ''}`);
    lines.push(`**Viewport:** ${d.viewportWidth || '?'}×${d.viewportHeight || '?'} · **UA:** ${d.userAgent || '?'}`);
    lines.push(`**Language:** ${d.language || '?'} · **Direction:** ${d.dir || '?'}`);
    if (d.connection) lines.push(`**Connection:** ${d.connection}`);
    lines.push('');

    const env = envKeys(d.storagePairs, d.envPrefixes);
    if (env.length) {
      lines.push('## Environment');
      lines.push('');
      for (const [k, v] of env) lines.push(`- ${k}: ${v}`);
      lines.push('');
    }

    const err = entryLines(d.consoleErrors, 'Console errors');
    const warn = entryLines(d.consoleWarnings, 'Console warnings');
    lines.push(...err, ...warn);

    const failed = failedRequests(d.resources, d.pageOrigin);
    if (failed.length) {
      lines.push(`## Failed requests (${failed.length})`, '');
      lines.push('| status | type | time | url |');
      lines.push('|---|---|---|---|');
      for (const f of failed) lines.push(`| ${f.status} | ${f.type} | ${f.ms} ms | ${f.url} |`);
      lines.push('');
    }

    if (d.storage) {
      lines.push(
        '## Storage',
        '',
        `- localStorage: ${d.lsCount ?? '?'} keys (~${fmtBytes(d.lsBytes)})` +
          ` · sessionStorage: ${d.ssCount ?? '?'} keys (~${fmtBytes(d.ssBytes)})`,
        ''
      );
    }

    lines.push('## Steps to reproduce', '', '1. ', '2. ', '');
    if (d.screenshot) lines.push(`_Screenshot captured (${d.screenshot.width || '?'}×${d.screenshot.height || '?'} PNG) and saved with this report._`);
    lines.push('_Generated by UA Bug Reporter._');
    return lines.join('\n');
  }

  // ---------- report history (pure list ops; caller persists) ----------

  function appendReport(list, report, budget) {
    const cap = budget || STORAGE_BUDGET;
    const next = (list || []).slice();
    next.unshift(report);
    const size = (r) => (r.markdown || '').length * 2 + ((r.png && r.png.length) || 0) * 2;
    let total = next.reduce((acc, r) => acc + size(r), 0);
    while (next.length > MAX_REPORTS || (total > cap && next.length > 1)) {
      const dropped = next.pop();
      total -= size(dropped);
    }
    return next;
  }

  return {
    MAX_TEXT,
    MAX_REPORTS,
    STORAGE_BUDGET,
    DEFAULT_ENV_PREFIXES,
    failedRequests,
    bytesOf,
    envKeys,
    truncate,
    fmtBytes,
    buildMarkdown,
    appendReport
  };
});
