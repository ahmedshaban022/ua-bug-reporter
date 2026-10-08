// Produces the Chrome Web Store 1280x800 screenshot: the failing demo
// page with the popup-style overlay mock visible (?shot=1).
// Run: NODE_PATH="<workspace>/.devdeps/node_modules" node tools/make-screenshot.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(ROOT, 'test', 'demo');
const OUT = path.join(ROOT, 'store', 'screenshot-1280x800.png');

async function main() {
  const { chromium } = require('playwright-core');
  const srv = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    if (route === '/hook.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(fs.readFileSync(path.join(ROOT, 'content', 'console-hook.js')));
      return;
    }
    if (route === '/missing' || route === '/boom') {
      res.writeHead(route === '/boom' ? 500 : 404);
      res.end('x');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(DEMO, 'index.html')));
  });
  await new Promise((resolve) => srv.listen(3898, '127.0.0.1', resolve));

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('http://127.0.0.1:3898/projects/42?tab=finance&shot=1', { waitUntil: 'load' });
    await page.waitForTimeout(700); // errors fire at ~50ms; overlay shows at ~150ms
    const box = await page.locator('#mock').boundingBox();
    if (!box || box.width < 200 || box.height < 100) throw new Error('overlay mock not visible: ' + JSON.stringify(box));
    const errline = await page.textContent('#errline');
    if (!errline.includes('failed to mount')) throw new Error('demo failure state missing');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT });
    console.log('store screenshot written:', OUT, '(overlay', Math.round(box.width) + 'x' + Math.round(box.height) + ')');
  } finally {
    await browser.close();
    srv.close();
  }
}

main().catch((e) => {
  console.error('make-screenshot crashed:', e);
  process.exit(1);
});
