import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../../browser-extension/status.js', import.meta.url), 'utf8');
async function openPage(data: Record<string, unknown>) {
  let reloads = 0;
  runInNewContext(source, { document: { getElementById: () => ({ textContent: '' }) }, chrome: {
    storage: { local: { get: async () => ({ ...data }), set: async (values: Record<string, unknown>) => Object.assign(data, values) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ accepted: true }), reload: () => { reloads++; } },
  } });
  await new Promise(resolve => setTimeout(resolve, 5)); return reloads;
}
test('connection page upgrades an older resident worker once and never reloads current workers', async () => {
  const old = { workerVersion: 4 };
  assert.equal(await openPage(old), 1); assert.equal(await openPage(old), 0);
  assert.equal(await openPage({ workerVersion: 5 }), 0);
});
