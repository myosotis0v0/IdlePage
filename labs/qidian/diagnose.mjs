import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openManualSession } from './browser.mjs';
import { observePage, isOfficialPage } from './probe.mjs';

const artifacts = fileURLToPath(new URL('../../.local/qidian/', import.meta.url));
await mkdir(artifacts, { recursive: true });

export async function observeAccess(page) {
  if (!isOfficialPage(page.url())) return { state: 'OutsideQidian', frames: [], page: { skipped: true, reason: 'outside-qidian' } };
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const url = new URL(frame.url());
      if (!isOfficialPage(frame.url()) && !(url.protocol === 'https:' && url.hostname === 'captcha.gtimg.com')) continue;
      const signals = await frame.evaluate(() => {
        const body = document.body?.innerText ?? '';
        return {
          bodyCharacters: [...body].length,
          verification: /安全验证|访问验证|拖动下方滑块|人机验证|完成拼图/.test(body),
          tooFrequent: /操作过于频繁|操作太频繁|稍后再试/.test(body),
          webdriver: navigator.webdriver,
          visibleIframeCount: [...document.querySelectorAll('iframe')].filter(node => node.getClientRects().length).length,
        };
      });
      frames.push({ host: url.hostname, isMainFrame: frame === page.mainFrame(), ...signals });
    } catch { frames.push({ unavailable: true }); }
  }
  const pageSignals = await observePage(page);
  const blocked = frames.some(frame => frame.verification || frame.tooFrequent);
  return {
    observedAt: new Date().toISOString(), frames, page: pageSignals,
    state: blocked ? 'AccessBlocked' : pageSignals.skipped ? 'OutsideQidian' :
      pageSignals.bodyCharacters > 0 && pageSignals.bookLinks > 0 ? 'SiteContentVisible' : 'Indeterminate',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const context = await openManualSession();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto('https://www.qidian.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const samples = [];
    // One navigation, no CAPTCHA interaction or retries.
    for (let index = 0; index < 4; index++) {
      await delay(4000);
      const sample = await observeAccess(page);
      samples.push(sample);
      console.log(JSON.stringify({ httpStatus: response?.status(), ...sample }));
      if (sample.state === 'AccessBlocked') break;
    }
    await writeFile(artifacts + 'sandbox-diagnostic.json', JSON.stringify({ mode: 'playwright-sandbox-enabled', samples }, null, 2));
  } finally { await context.close(); }
}
