// Service worker: report building (page facts + console buffer + optional
// screenshot), per-origin console-capture arming, and report history.
// reportcore.js is a dual-format module: importing it for side effects
// installs self.UAReportCore.

import './shared/reportcore.js';
import { collectFromTab, readConsoleBuffer } from './shared/inject.js';

const R = () => self.UAReportCore;

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
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
  try {
    await chrome.permissions.remove({ origins: [origin + '/*'] });
  } catch (_) {
    /* permission already gone */
  }
  return { armed: false };
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
  if (!tab || tab.id == null || !tab.url || !/^https?:/i.test(tab.url)) return null;

  const settings = await chrome.storage.sync.get({
    envPrefixes: R().DEFAULT_ENV_PREFIXES,
    includeScreenshot: true,
    includeStorage: true
  });

  const facts = await collectFromTab(tab.id, { includeStorage: settings.includeStorage }).catch(() => null);
  if (!facts || facts.error) return null;
  const console_ = await readConsoleBuffer(tab.id);

  let png = null;
  let shotDims = null;
  if (settings.includeScreenshot) {
    try {
      png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      shotDims = { width: facts.viewportWidth, height: facts.viewportHeight };
    } catch (_) {
      png = null; // capture refused (no gesture/activeTab, or hidden window)
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
  const markdown = R().buildMarkdown(data);
  const failed = R().failedRequests(facts.resources, facts.pageOrigin);

  const report = {
    id: 'r-' + Date.now().toString(36),
    at: Date.now(),
    url: facts.url,
    title: facts.title,
    armed: !!console_.armed,
    markdown,
    png,
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

async function doBuild(openPage) {
  const tab = await activeTab();
  const report = await buildReport(tab).catch(() => null);
  if (report && openPage) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') + '?id=' + report.id });
  }
  return report;
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
  if (command === 'build-report') doBuild(true);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'ua-br-report') doBuild(true);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const run = (p) => p.then(sendResponse).catch(() => sendResponse(null));
  if (msg.type === 'ua-br:build') {
    run(doBuild(false));
    return true;
  }
  if (msg.type === 'ua-br:arm') {
    run((async () => {
      // the popup already obtained the optional origin permission (user
      // gesture lives there); here we only register + reload
      const tab = await activeTab();
      const origin = new URL(tab.url).origin;
      return armOrigin(origin, tab.id);
    })());
    return true;
  }
  if (msg.type === 'ua-br:disarm') {
    run(
      (async () => {
        const tab = await activeTab();
        const origin = new URL(tab.url).origin;
        return disarmOrigin(origin);
      })()
    );
    return true;
  }
  if (msg.type === 'ua-br:armed') {
    run(
      (async () => {
        const tab = await activeTab();
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return { armed: false, error: 'not-a-page' };
        return { armed: await isArmed(new URL(tab.url).origin) };
      })()
    );
    return true;
  }
  return undefined;
});
