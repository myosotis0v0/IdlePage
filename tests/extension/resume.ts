import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

export async function run() {
  const extension = vscode.extensions.getExtension('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  const expected = JSON.parse(await readFile(join(extension.extensionPath, '.local/resume-expected.json'), 'utf8'));
  assert.equal(api.getReaderStatus().count, '', 'startup must not display or fetch a book automatically');
  assert.equal(api.getReaderStatus().hidden, true, 'saved reading starts hidden for existing toggle keybindings');
  const endpoint = api.getBridgeStatus().endpoint;
  const directory = api.getCompanionDirectory();
  const pairing = await readFile(join(directory, 'pairing.js'), 'utf8');
  const token = /export const token = "([a-f0-9]{64})";/.exec(pairing)![1];
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).split('').map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: `chrome-extension://${id}` };
  const post = async (path: string, data: unknown) => {
    const response = await fetch(endpoint + path, { method: 'POST', headers, body: JSON.stringify(data) });
    assert.equal(response.status, 200); return response.json();
  };
  await vscode.commands.executeCommand('idlepage.toggleReading');
  const catalogTask = (await post('/v1/tasks/next', {})).task;
  assert.equal(catalogTask.kind, 'catalog'); assert.equal(catalogTask.bookId, '123');
  const report = { state: 'SiteContentVisible', pageKind: 'book', bodyCharacters: 1500, bookLinks: 0, verification: false, tooFrequent: false, captchaFrame: false };
  await post('/v1/tasks/result', { taskId: catalogTask.id, report });
  await post('/v1/catalog/result', { taskId: catalogTask.id, report: { bookId: '123', offset: 0, total: 2, declaredCount: 2, truncated: false, strategy: 'catalog-container', chapters: ['11', '12'].map(id => ({ id, title: 'Fixture', url: `https://www.qidian.com/chapter/123/${id}/`, volume: '', payment: 'unknown' })) } });
  const chapterTask = (await post('/v1/tasks/next', {})).task;
  assert.equal(chapterTask.url, 'https://www.qidian.com/chapter/123/12/', 'resume saved chapter instead of first chapter');
  await post('/v1/tasks/result', { taskId: chapterTask.id, report: { ...report, pageKind: 'chapter' } });
  await post('/v1/chapter/result', { taskId: chapterTask.id, report: { status: 'available', offset: 0, total: expected.body.length, text: expected.body } });
  assert.equal(api.getReaderStatus().count, '2/2');
  assert.equal(api.getReaderStatus().offset, expected.offset);
  assert.equal(api.getReaderStatus().hidden, false);
  console.log('Restart resume passed: toggle command fetched saved chapter and restored exact UTF-16 offset, without opening Edge.');
}
