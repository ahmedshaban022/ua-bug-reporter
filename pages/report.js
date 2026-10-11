// Report page: renders a stored report (markdown + screenshot), offers
// copy/download, and lists history. The markdown renderer covers exactly
// the subset UAReportCore emits — headers, bold/italic, fenced code,
// tables, lists — with HTML escaped first.

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

function renderMarkdown(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let inCode = false;
  let inTable = false;
  let tableRows = [];
  let inList = false;

  const flushTable = () => {
    if (!tableRows.length) return;
    const [head, ...rows] = tableRows;
    const cells = (r) => r.map((c) => `<td>${inline(c)}</td>`).join('');
    out.push('<table><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>');
    for (const r of rows) out.push('<tr>' + cells(r) + '</tr>');
    out.push('</table>');
    tableRows = [];
    inTable = false;
  };
  const flushList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      flushTable();
      flushList();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(raw));
      continue;
    }
    if (/^\|/.test(line)) {
      flushList();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (/^\|[\s|:-]+\|?$/.test(line)) continue; // separator row
      tableRows.push(cells);
      inTable = true;
      continue;
    }
    if (inTable) flushTable();
    if (line.startsWith('## ')) {
      flushList();
      out.push(`<h2>${inline(esc(line.slice(3)))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      flushList();
      out.push(`<h1>${inline(esc(line.slice(2)))}</h1>`);
      continue;
    }
    if (/^- /.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(esc(line.slice(2)))}</li>`);
      continue;
    }
    flushList();
    if (/^\d+\. /.test(line)) {
      out.push(`<p>${inline(esc(line))}</p>`);
      continue;
    }
    if (line === '') continue;
    out.push(`<p>${inline(esc(line))}</p>`);
  }
  flushTable();
  flushList();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

let current = null;

function download(name, url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function slug(s) {
  return String(s || 'report')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase() || 'report';
}

async function load() {
  const { reports = [] } = await chrome.storage.local.get({ reports: [] });
  const list = $('list');
  list.textContent = '';
  if (!reports.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No reports yet — build one from the popup.';
    list.appendChild(empty);
  }
  const wanted = new URLSearchParams(location.search).get('id');
  current = reports.find((r) => r.id === wanted) || reports[0] || null;
  $('copy').disabled = !current;
  $('dlmd').disabled = !current;
  $('dlpng').disabled = !(current && current.png);
  $('shot').hidden = !(current && current.png);
  for (const r of reports) {
    const item = document.createElement('div');
    item.className = 'item' + (current && r.id === current.id ? ' sel' : '');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = new Date(r.at || Date.now()).toLocaleString();
    const u = document.createElement('div');
    u.className = 'u';
    u.textContent = r.url || '';
    item.appendChild(t);
    item.appendChild(u);
    item.addEventListener('click', () => {
      location.search = '?id=' + r.id;
    });
    list.appendChild(item);
  }

  if (!current) {
    $('md').innerHTML = '<div class="none">Nothing to show.</div>';
    $('dlpng').disabled = true;
    return;
  }
  $('md').innerHTML = renderMarkdown(current.markdown);
  if (current.png) {
    $('shot').src = current.png;
    $('shot').hidden = false;
  }
}

$('copy').addEventListener('click', async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.markdown);
    $('copy').textContent = 'Copied ✓';
  } catch (_) {
    $('copy').textContent = 'Copy failed';
  }
  setTimeout(() => ($('copy').textContent = 'Copy markdown'), 1500);
});

$('dlmd').addEventListener('click', () => {
  if (!current) return;
  const blob = new Blob([current.markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  download('bug-report-' + slug(new URL(current.url || 'x').hostname) + '.md', url);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('dlpng').addEventListener('click', () => {
  if (!current || !current.png) return;
  download('bug-report-screenshot.png', current.png);
});

load().catch(() => {
  $('md').innerHTML = '<div class="none">Failed to load reports.</div>';
});
