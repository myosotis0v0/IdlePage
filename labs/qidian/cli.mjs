import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openPublicBrowser, openManualSession } from './browser.mjs';
import { PUBLIC_TARGETS, observePage } from './probe.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = resolve(root, '.local/qidian');
await mkdir(artifacts, { recursive: true });
async function save(name, value) {
  const file = resolve(artifacts, name);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
const mode = process.argv[2];
if (mode === 'public') {
  const browser = await openPublicBrowser();
  const results = [];
  try {
    const page = await browser.newPage();
    for (const url of PUBLIC_TARGETS) {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Let dynamic content render; this is not proof of successful extraction.
        await delay(2000);
        const record = { target: url, httpStatus: response?.status() ?? null, ...await observePage(page) };
        results.push(record);
        console.log(JSON.stringify(record));
      } catch (error) {
        // Do not print error messages that may contain redirected authentication URLs.
        const record = { target: url, errorType: error.name };
        results.push(record);
        console.log(JSON.stringify(record));
      }
    }
    await save('public-report.json', { results });
    if (results.every(record => record.errorType)) process.exitCode = 1;
  } finally { await browser.close(); }
} else if (mode === 'session') {
  let context;
  try { context = await openManualSession(); }
  catch (error) {
    console.error(`Cannot open dedicated browser (${error.name}). Close an earlier IdlePage probe window before retrying.`);
    process.exit(1);
  }
  let closed = false;
  context.on('close', () => { closed = true; });
  process.on('SIGINT', () => { void context.close(); });
  process.on('SIGTERM', () => { void context.close(); });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto('https://www.qidian.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) { console.log(`Initial navigation failed (${error.name}); navigate manually in the browser.`); }
  console.log('Official browser ready. Log in manually, open your bookshelf, then a free and an already purchased chapter. No automated clicks or purchases.');
  let cycles = 0;
  while (!closed) {
    const pages = [];
    for (const current of context.pages()) {
      try { pages.push(await observePage(current)); }
      catch { pages.push({ skipped: true, reason: 'page-changing-or-closed' }); }
    }
    await save('session-report.json', {
      updatedAt: new Date().toISOString(), phase: 'manual-session', cycles: ++cycles, pages,
      note: 'DOM signals alone do not prove login, bookshelf ownership or full VIP extraction.',
    });
    await delay(5000);
  }
  await save('session-end.json', { closedAt: new Date().toISOString(), cycles });
} else {
  console.error('Usage: node labs/qidian/cli.mjs public|session');
  process.exitCode = 1;
}
