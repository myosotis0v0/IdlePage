import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

await mkdir('.local/wheel-test', { recursive: true });
const modulePath = resolve('.local/wheel-test/reader.mjs');
await build({ entryPoints: ['src/ui/ReadingLocation.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'vscode-stub', setup(b) {
  b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const commands={},window={},workspace={},extensions={},ConfigurationTarget={};' }));
} }] });
const { readingLocationHtml } = await import(pathToFileURL(modulePath).href);
const htmlPath = resolve('.local/wheel-test/reader.html');
await writeFile(htmlPath, readingLocationHtml());
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 220 } });
  await page.addInitScript(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage(m) { if (m.command) window.messages.push(m.command); } }); });
  await page.goto(pathToFileURL(htmlPath).href);
  const state = async (extra = {}) => page.evaluate(extra => window.postMessage({ count: '1/3', text: 'Synthetic short reading text.', progress: 0, hidden: false, ...extra }, '*'), extra);
  const messages = () => page.evaluate(() => window.messages);
  const wheel = async (selector, deltaY, extra = {}) => page.locator(selector).evaluate((el, args) => {
    const r = el.getBoundingClientRect(); el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, ...args }));
  }, { deltaY, ...extra });
  await state(); await page.waitForTimeout(30);
  await wheel('header', 120); await wheel('body', 120); await wheel('#text', 120, { ctrlKey: true });
  await wheel('#text', 120, { clientX: -10 });
  assert.deepEqual(await messages(), [], 'Only the unmodified wheel over reading text is accepted');
  await wheel('#text', 120); await wheel('#text', 120); await wheel('#text', -120);
  assert.deepEqual(await messages(), ['nextSegment'], 'One turn per burst');
  await page.waitForTimeout(380); await wheel('#text', -120);
  assert.deepEqual(await messages(), ['nextSegment', 'previousSegment']);
  await state({ hidden: true }); await page.waitForTimeout(380); await wheel('#text', 120);
  await state({ error: 'Synthetic failure' }); await page.waitForTimeout(30); await wheel('#text', 120);
  await state({ count: '' }); await page.waitForTimeout(30); await wheel('#text', 120);
  assert.equal((await messages()).length, 2, 'Hidden, failed and empty readers never navigate');
  await state({ text: 'Long fixture text. '.repeat(500) }); await page.waitForTimeout(30);
  const area = page.locator('#text'); await area.hover(); await page.mouse.wheel(0, 120); await page.waitForTimeout(200);
  assert.ok(await area.evaluate(el => el.scrollTop > 0), 'Overflow scrolls normally before the edge');
  assert.equal((await messages()).length, 2);
  await area.evaluate(el => { el.scrollTop = el.scrollHeight; }); await page.waitForTimeout(380); await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50); assert.equal((await messages()).at(-1), 'nextSegment');
  console.log('Webview wheel region, direction, burst guard, reader states and overflow tests passed.');
} finally { await browser.close(); }
