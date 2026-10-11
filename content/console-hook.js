// MAIN-world console hook: records console.error/warn, uncaught errors,
// and unhandled rejections into a capped ring on window.__uaBugBuffer.
// Registered at document_start for the armed origin only, and never for
// the whole web. Idempotent: re-registration replaces nothing, wraps once.
'use strict';
(function () {
  if (window.__uaBugBufferInstalled) return;
  window.__uaBugBufferInstalled = true;

  const MAX_ENTRIES = 200; // ring cap: enough for a bad page load, bounded always

  const buffer = (window.__uaBugBuffer = window.__uaBugBuffer || { errors: [], warnings: [] });
  let stopped = false;

  function push(bucket, kind, text, stack) {
    if (stopped) return;
    if (bucket.length >= MAX_ENTRIES) bucket.shift();
    bucket.push({ t: Date.now(), kind, text: String(text || '').slice(0, 1000), stack: stack ? String(stack).slice(0, 2000) : null });
  }

  function fmt(args) {
    const parts = [];
    for (const a of args || []) {
      if (a instanceof Error) parts.push(a.message); // stack kept separately
      else if (typeof a === 'string') parts.push(a);
      else {
        try {
          parts.push(JSON.stringify(a));
        } catch (_) {
          parts.push(String(a)); /* circular structure: fall back to label */
        }
      }
    }
    return parts.join(' ');
  }

  const origError = console.error;
  const origWarn = console.warn;
  const errorHook = console.error = function (...args) {
    const first = args.find((a) => a instanceof Error);
    push(buffer.errors, 'console.error', fmt(args), first ? first.stack : null);
    origError.apply(console, args);
  };
  const warnHook = console.warn = function (...args) {
    const first = args.find((a) => a instanceof Error);
    push(buffer.warnings, 'console.warn', fmt(args), first ? first.stack : null);
    origWarn.apply(console, args);
  };

  const onError = (e) => {
    push(buffer.errors, 'uncaught', e.message, e.error && e.error.stack);
  };
  const onRejection = (e) => {
    const r = e.reason;
    push(buffer.errors, 'unhandledrejection', r instanceof Error ? r.message : fmt([r]), r instanceof Error ? r.stack : null);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.__uaBugReporterStop = () => {
    stopped = true;
    if (console.error === errorHook) console.error = origError;
    if (console.warn === warnHook) console.warn = origWarn;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    delete window.__uaBugBuffer;
    delete window.__uaBugBufferInstalled;
    delete window.__uaBugReporterStop;
  };
})();
