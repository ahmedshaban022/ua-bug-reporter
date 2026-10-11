// Service worker: report building (page facts + console buffer + optional
// screenshot), per-origin console-capture arming, and report history.
// reportcore.js is a dual-format module: importing it for side effects
// installs self.UAReportCore.

import './shared/reportcore.js';
import { collectFromTab, readConsoleBuffer } from './shared/inject.js';
import { pageTab, requirePage, failure } from './shared/runtime.js';

const R = () => self.UAReportCore;
let building = false;
let lastScreenshotAt = 0;

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function activeTabOrigin() {
  const tab = await activeTab();
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return null;
  return new URL(tab.url).origin;
}

// ---------- console-capture arming (opt-in, per origin) ----------

function originKey(origin) {
  return origin.replace(/[^a-z0-9.:-]+/gi, '_');
}

async function getArmed() {
  try {
    const s = await chrome.storage.session.get({ armed: {} });
    return s.armed && typeof s.armed === 'object' ? s.armed : {};
  } catch (_) {
    return {}; /* storage.session unavailable: arming state just won't survive SW restarts */
  }
}

async function setArmed(origin, on) {
  const armed = await getArmed();
  if (on) armed[originKey(origin)] = origin;
  else delete armed[originKey(origin)];
  try {
    await chrome.storage.session.set({ armed });
  } catch (_) {
    /* session storage gone; registration itself is the source of truth */
  }
}

async function armOrigin(origin, tabId) {
  if (await isArmed(origin)) return { armed: true };
  const id = 'ua-br-hook-' + originKey(origin);
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [origin + '/*'],
      js: ['content/console-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: false
    }
  ]);
  await setArmed(origin, true);
  if (tabId != null) await chrome.tabs.reload(tabId);
  return { armed: true };
}

async function disarmOrigin(origin) {
  const id = 'ua-br-hook-' + originKey(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch (_) {
    /* not registered (browser restarted): nothing to remove */
  }
  await setArmed(origin, false);
  // Unregistering only affects future documents. Stop existing hooks before
  // revoking the permission needed to reach this origin's open pages.
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  let reloaded = false;
  await Promise.all(tabs.map(async tab => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (typeof window.__uaBugReporterStop === 'function') { window.__uaBugReporterStop(); return false; }
          return !!window.__uaBugBufferInstalled;
        }
      });
      // Older hooks have no cleanup function; a reload removes them.
      if (results.some(r => r.result)) { await chrome.tabs.reload(tab.id); reloaded = true; }
    } catch (_) { /* closed or inaccessible page */ }
  }));
  try {
    await chrome.permissions.remove({ origins: [origin + '/*'] });
  } catch (_) {
    /* permission already gone */
  }
  return { armed: false, reloaded };
}

async function isArmed(origin) {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const id = 'ua-br-hook-' + originKey(origin);
    return scripts.some((s) => s.id === id);
  } catch (_) {
    return false;
  }
}

// ---------- report building ----------

async function buildReport(tab) {
  // file: pages can be reported on too (they need the user's "Allow access
  // to file URLs" opt-in); console arming stays http(s)-only because file
  // origins can't be granted through the optional-permissions prompt
  requirePage(tab, true);

  const settings = await chrome.storage.sync.get({
    envPrefixes: R().DEFAULT_ENV_PREFIXES,
    includeScreenshot: true,
    includeStorage: true
  });

  const facts = await collectFromTab(tab.id, { includeStorage: settings.includeStorage });
  if (!facts || facts.error) throw new Error(facts && facts.error || 'Could not collect this page.');
  const origin = /^https?:/i.test(tab.url) ? new URL(tab.url).origin : null;
  const console_ = origin && await isArmed(origin)
    ? await readConsoleBuffer(tab.id) : { armed: false, errors: [], warnings: [] };

  let png = null;
  let shotDims = null;
  let screenshotWarning = null;
  if (settings.includeScreenshot) {
    try {
      const wait = 550 - (Date.now() - lastScreenshotAt);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
      if (!active || active.id !== tab.id) throw new Error('Keep the report page tab active while building.');
      lastScreenshotAt = Date.now();
      png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      shotDims = { width: facts.viewportWidth, height: facts.viewportHeight };
    } catch (error) {
      png = null; // capture refused (no gesture/activeTab, or hidden window)
      screenshotWarning = 'Screenshot not attached. ' + failure(error).error;
    }
  }

  const data = Object.assign({}, facts, {
    time: new Date().toISOString(),
    envPrefixes: settings.envPrefixes,
    storage: settings.includeStorage,
    consoleErrors: console_.errors || [],
    consoleWarnings: console_.warnings || [],
    screenshot: png ? shotDims : null
  });
  const markdown = R().buildMarkdown(data) + (screenshotWarning ? '\n' + screenshotWarning + '\n' : '');
  const failed = R().failedRequests(facts.resources, facts.pageOrigin);

  const report = {
    id: 'r-' + Date.now().toString(36),
    at: Date.now(),
    url: facts.url,
    title: facts.title,
    armed: !!console_.armed,
    markdown,
    png,
    screenshotWarning,
    counts: {
      errors: (console_.errors || []).length,
      warnings: (console_.warnings || []).length,
      failed: failed.length
    }
  };

  const { reports } = await chrome.storage.local.get({ reports: [] });
  await chrome.storage.local.set({ reports: R().appendReport(reports, report) });
  return report;
}

async function doBuild(openPage, tabId) {
  if (building) throw new Error('A report is already being built. Wait for it to finish.');
  building = true;
  try {
    const tab = await pageTab(tabId);
    const report = await buildReport(tab);
    if (report && openPage) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') + '?id=' + report.id });
    }
    return report;
  } finally {
    building = false;
  }
}

// ---------- wiring ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ua-br-report',
    title: 'Build bug report for this page',
    contexts: ['page']
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'build-report') doBuild(true).catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ua-br-report') doBuild(true, tab && tab.id).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const run = (p) => p.then(sendResponse).catch((e) => sendResponse(failure(e)));
  if (msg.type === 'ua-br:build') {
    run(doBuild(false, msg.tabId));
    return true;
  }
  if (msg.type === 'ua-br:arm') {
    run((async () => {
      // the popup already obtained the optional origin permission (user
      // gesture lives there) and passes the origin it was opened on
      const origin = msg.origin || (await activeTabOrigin());
      if (!origin) return { armed: false, error: 'not-a-page' };
      const tab = await pageTab(msg.tabId);
      return armOrigin(origin, tab && tab.id);
    })());
    return true;
  }
  if (msg.type === 'ua-br:disarm') {
    run(
      (async () => {
        const origin = msg.origin || (await activeTabOrigin());
        if (!origin) return { armed: false, error: 'not-a-page' };
        return disarmOrigin(origin);
      })()
    );
    return true;
  }
  if (msg.type === 'ua-br:armed') {
    run(
      (async () => {
        const origin = msg.origin || (await activeTabOrigin());
        if (!origin) return { armed: false, error: 'not-a-page' };
        return { armed: await isArmed(origin) };
      })()
    );
    return true;
  }
  return undefined;
});
