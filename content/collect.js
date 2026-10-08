// Isolated-world collector: gathers page facts, storage summaries, env
// keys, and the resource-timing failures. Returns plain structured-clone
// data and never throws across the boundary. The MAIN-world console
// buffer is read separately by the service worker (world: 'MAIN').
'use strict';
(function () {
  const UBR = (window.UABugReporter = window.UABugReporter || {});
  const C = window.UAReportCore;

  UBR.collect = function (opts) {
    const o = opts || {};
    const ls = safeStore(() => localStorage);
    const ss = safeStore(() => sessionStorage);
    const pairs = [];
    for (const store of [ls, ss]) {
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k != null) pairs.push([k, store.getItem(k)]);
      }
    }

    let resources = [];
    try {
      resources = performance.getEntriesByType('resource').map((e) => ({
        name: e.name,
        initiatorType: e.initiatorType,
        duration: e.duration,
        transferSize: e.transferSize,
        responseStatus: e.responseStatus
      }));
    } catch (_) {
      /* resource timing disabled (privacy flags); report simply has no request section */
    }

    return {
      url: location.href,
      title: document.title,
      pageOrigin: location.origin,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      userAgent: navigator.userAgent,
      language: navigator.language,
      dir: document.dir || 'ltr',
      connection: navigator.connection && navigator.connection.effectiveType ? navigator.connection.effectiveType : null,
      storage: o.includeStorage !== false,
      lsCount: ls ? ls.length : 0,
      ssCount: ss ? ss.length : 0,
      lsBytes: C ? C.bytesOf(ls) : 0,
      ssBytes: C ? C.bytesOf(ss) : 0,
      storagePairs: pairs,
      resources
    };
  };

  function safeStore(get) {
    try {
      return get();
    } catch (_) {
      return null; // storage blocked (site settings / cookies disabled)
    }
  }
})();
