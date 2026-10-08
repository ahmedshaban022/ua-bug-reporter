// Shared injection helpers used by the service worker. Two worlds matter:
// the ISOLATED world for page facts (collect.js) and the MAIN world for
// the console buffer installed by console-hook.js. Both files are
// idempotent, so re-injecting before every action is safe.

export const ISOLATED_FILES = ['shared/reportcore.js', 'content/collect.js'];

export async function collectFromTab(tabId, opts) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ISOLATED_FILES
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => (window.UABugReporter ? window.UABugReporter.collect(opts) : { error: 'not-loaded' }),
    args: [opts || {}]
  });
  const r = results && results[0];
  return r && typeof r.result === 'object' && r.result !== null ? r.result : { error: 'no-result' };
}

export async function readConsoleBuffer(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const b = window.__uaBugBuffer;
        return b
          ? {
              armed: true,
              errors: (b.errors || []).slice(-50),
              warnings: (b.warnings || []).slice(-50)
            }
          : { armed: false, errors: [], warnings: [] };
      }
    });
    const r = results && results[0];
    return r && typeof r.result === 'object' && r.result !== null ? r.result : { armed: false, errors: [], warnings: [] };
  } catch (_) {
    return { armed: false, errors: [], warnings: [] }; /* MAIN-world read failed; report proceeds without console */
  }
}
