// Shared setup for the browser tests: launch Chromium through Playwright, serve
// the repository through request routing (no web server needed), and count
// checks. Each test file imports this and calls finish() at the end.

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch (e) { /* fall back to a global install */ }
  const g = execSync('npm root -g').toString().trim();
  return createRequire(path.join(g, '/'))('playwright');
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.csv': 'text/csv',
};

/**
 * Open the app on a fresh page with empty localStorage.
 * The repository root is argv[2], else the parent of tests/.
 */
export async function openApp({ width = 1366, height = 768 } = {}) {
  const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  await page.route('http://app.local/**', (r) => {
    const u = new URL(r.request().url());
    const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return r.fulfill({ status: 404, body: 'nf' });
    r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });

  const boot = async () => {
    await page.waitForFunction(() => document.querySelector('#boot').classList.contains('done'), null, { timeout: 60000 });
    await page.waitForTimeout(300);
  };
  await page.goto('http://app.local/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await boot();

  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  };
  const finish = async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(errs.join('\n') || 'no page errors');
    await browser.close();
    process.exit(fail || errs.length ? 1 : 0);
  };
  const clickText = (t) => page.locator('button', { hasText: t }).first().click();
  return { page, boot, check, finish, clickText, errs, root: ROOT };
}
