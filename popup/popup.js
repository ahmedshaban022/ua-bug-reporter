// Popup logic: settings, per-origin console arming (the permission prompt
// must originate from this gesture context), and report building via the
// service worker.
const $ = (id) => document.getElementById(id);

const DEFAULT_PREFIXES = ['build', 'release', 'version', 'env', 'flag_'];

function send(type, extra) {
  return chrome.runtime.sendMessage(Object.assign({ type }, extra || {})).catch(() => null);
}

let isHttpPage = false;
let currentOrigin = null;

function setStatus(html) {
  $('stats').innerHTML = html || '';
}

async function init() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
  const url = (tab && tab.url) || '';
  isHttpPage = /^https?:/i.test(url);
  try {
    currentOrigin = isHttpPage ? new URL(url).origin : null;
  } catch (_) {
    currentOrigin = null;
  }
  $('page').textContent = isHttpPage ? url : 'Not an http(s) page';
  $('build').disabled = !isHttpPage;
  $('arm').disabled = !isHttpPage;

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

  if (isHttpPage) renderArm(await send('ua-br:armed'));
}

function renderArm(res) {
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
  chrome.storage.sync.set({
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
  $(id).addEventListener('change', saveSettings);
}

$('arm').addEventListener('click', async () => {
  if (!isHttpPage || !currentOrigin) return;
  const state = await send('ua-br:armed');
  if (state && state.armed) {
    renderArm(await send('ua-br:disarm'));
    setStatus('Console capture disarmed.');
    return;
  }
  // The optional-origin permission must be requested from this click.
  const granted = await chrome.permissions
    .request({ origins: [currentOrigin + '/*'] })
    .catch(() => false);
  if (!granted) {
    setStatus('Permission declined — capture not armed.');
    return;
  }
  renderArm(await send('ua-br:arm'));
  setStatus('Armed. The page reloads now; errors collect until you build the report.');
});

$('build').addEventListener('click', async () => {
  if (!isHttpPage) {
    setStatus('Open a normal http(s) page first.');
    return;
  }
  saveSettings();
  setStatus('Building…');
  const res = await send('ua-br:build');
  if (!res) {
    setStatus('Could not build on this page (try a normal http(s) page).');
    return;
  }
  const c = res.counts || {};
  setStatus(
    `Report ready: <b>${c.errors || 0}</b> error(s), ${c.warnings || 0} warning(s), ${c.failed || 0} failed request(s)` +
      (res.armed ? '' : ' · console not armed')
  );
  const { reports } = await chrome.storage.local.get({ reports: [] });
  $('history').textContent = 'History (' + (reports || []).length + ')';
  $('open').hidden = false;
  $('open').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') + '?id=' + res.id });
});

$('history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/report.html') });
});

init().catch(() => setStatus('Popup failed to start — try reopening it.'));
