// Popup logic: settings, per-origin console arming (the permission prompt
// must originate from this gesture context), and report building via the
// service worker.
import { request, showError, errorMessage } from '../shared/runtime.js';
const $ = (id) => document.getElementById(id);
let targetId = null;
let armed = false;
let ready = false;
let busy = false;

const DEFAULT_PREFIXES = ['build', 'release', 'version', 'env', 'flag_'];

function send(type, extra) {
  return request(type, { tabId: targetId, ...extra });
}

let isHttpPage = false;
let isBuildablePage = false;
let currentOrigin = null;

function setStatus(html) {
  $('stats').innerHTML = html || '';
}
function updateControls() {
  $('build').disabled = !ready || busy || !isBuildablePage;
  $('arm').disabled = !ready || busy || !isHttpPage;
  for (const id of ['shot', 'storage', 'prefixes']) $(id).disabled = !ready || busy;
}

// Reports work on file:// pages too (with Chrome's "Allow access to file
// URLs" opt-in); console arming needs a grantable origin, so http(s) only.
function buildFailText() {
  return isBuildablePage && !isHttpPage
    ? "Could not build — enable 'Allow access to file URLs' for this extension (chrome://extensions → Details)."
    : 'Could not build on this page (try a normal http(s) page).';
}

async function init() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
  targetId = tab && tab.id;
  const url = (tab && tab.url) || '';
  isHttpPage = /^https?:/i.test(url);
  isBuildablePage = isHttpPage || /^file:/i.test(url);
  try {
    currentOrigin = isHttpPage ? new URL(url).origin : null;
  } catch (_) {
    currentOrigin = null;
  }
  $('page').textContent = isBuildablePage ? url : 'Not an http(s) or file page';
  updateControls();

  const s = await chrome.storage.sync.get({
    envPrefixes: DEFAULT_PREFIXES,
    includeScreenshot: true,
    includeStorage: true
  });
  $('shot').checked = !!s.includeScreenshot;
  $('storage').checked = !!s.includeStorage;
  $('prefixes').value = (s.envPrefixes || []).join(', ');

  const { reports } = await chrome.storage.local.get({ reports: [] });
  $('history').textContent = 'History (' + (reports || []).length + ')';
  $('history').style.display = 'inline-block';

  if (isHttpPage) renderArm(await send('ua-br:armed', { origin: currentOrigin }));
  ready = true;
  updateControls();
}

function renderArm(res) {
  armed = !!(res && res.armed);
  const btn = $('arm');
  if (res && res.armed) {
    btn.textContent = 'Disarm console capture';
    btn.classList.add('on');
  } else {
    btn.textContent = 'Arm console capture for this site';
    btn.classList.remove('on');
  }
}

function saveSettings() {
  return chrome.storage.sync.set({
    includeScreenshot: $('shot').checked,
    includeStorage: $('storage').checked,
    envPrefixes: $('prefixes')
      .value.split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .slice(0, 12)
  });
}

for (const id of ['shot', 'storage', 'prefixes']) {
  $(id).addEventListener('change', () => saveSettings().catch(e => { $('stats').textContent = errorMessage(e); }));
}

$('arm').addEventListener('click', async () => {
  if (!ready || busy || !isHttpPage || !currentOrigin) return;
  busy = true;
  updateControls();
  try {
    if (armed) {
      const res = await send('ua-br:disarm', { origin: currentOrigin });
      if (showError($('stats'), res, 'Could not disarm capture.')) return;
      renderArm(res);
      setStatus('Console capture disarmed.' + (res.reloaded ? ' Reloaded pages to remove an older capture hook.' : ''));
      return;
    }
    // Request before any async message so Chrome retains this click's gesture.
    const granted = await chrome.permissions
      .request({ origins: [currentOrigin + '/*'] })
      .catch(() => false);
    if (!granted) {
      setStatus('Permission declined — capture not armed.');
      return;
    }
    const res = await send('ua-br:arm', { origin: currentOrigin });
    if (showError($('stats'), res, 'Could not arm capture.')) return;
    renderArm(res);
    setStatus(
      res && res.armed
        ? 'Armed. The page reloads now; errors collect until you build the report.'
        : 'Could not arm capture for this site.'
    );
  } catch (e) { $('stats').textContent = errorMessage(e); }
  finally { busy = false; updateControls(); }
});

$('build').addEventListener('click', async () => {
  if (!ready || busy) return;
  if (!isBuildablePage) {
    setStatus('Open a normal http(s) page or a local file first.');
    return;
  }
  busy = true;
  updateControls();
  try {
    await saveSettings();
    setStatus('Building…');
    const res = await send('ua-br:build');
    if (showError($('stats'), res, buildFailText())) return;
    const c = res.counts || {};
    setStatus(
      `Report ready: <b>${c.errors || 0}</b> error(s), ${c.warnings || 0} warning(s), ${c.failed || 0} failed request(s)` +
        (res.armed ? '' : ' · console not armed')
    );
    if (res.screenshotWarning) $('stats').append(document.createTextNode(' · ' + res.screenshotWarning));
    const { reports } = await chrome.storage.local.get({ reports: [] });
    $('history').textContent = 'History (' + (reports || []).length + ')';
    $('open').hidden = false;
    $('open').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') + '?id=' + res.id });
  } catch (e) { $('stats').textContent = errorMessage(e); }
  finally { busy = false; updateControls(); }
});

$('history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') });
});

init().catch((e) => ($('stats').textContent = errorMessage(e)));
