import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
interface Exports { getBridgeStatus(): { endpoint: string; phase: string }; getCompanionDirectory(): string }
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page');
  assert.ok(extension, 'development extension is registered');
  const api = await extension.activate();
  const companion = api.getCompanionDirectory();
  const pairing = await readFile(join(companion, 'pairing.js'), 'utf8');
  const token = /export const token = "([a-f0-9]{64})";/.exec(pairing)?.[1];
  assert.ok(token, 'local paired copy contains bridge credential');
  const manifest = JSON.parse(await readFile(join(companion, 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).split('').map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  const endpoint = api.getBridgeStatus().endpoint;
  const headers = { Origin: `chrome-extension://${id}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const first = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  const report = { state: 'SiteContentVisible', pageKind: 'other', bodyCharacters: 1500, bookLinks: 3, verification: false, tooFrequent: false, captchaFrame: false };
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: first.id, report }) })).status, 200);
  const shelf = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(shelf.kind, 'bookshelf');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: shelf.id, report: { ...report, pageKind: 'bookshelf' } }) })).status, 200);
  assert.equal(api.getBridgeStatus().phase, 'probe-complete');
  await vscode.commands.executeCommand('idlepage.restartProbe');
  assert.equal(api.getBridgeStatus().phase, 'waiting-access');
  console.log('IdlePage extension-host smoke test passed (synthetic observations; no Qidian requests).');
}