import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { hoverMenu, menuCommands } from '../../src/ui/navigation';
import { StatusReader } from '../../src/ui/StatusReader';
interface Exports { getBridgeStatus(): { endpoint: string; phase: string }; getCompanionDirectory(): string; getBrowserWindowMode(): string; getEntryStatus(): { text: string; hasClick: boolean; tooltip: string }; getReaderStatus(): { count: string; progress: number; offset: number; error?: string } }
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page');
  assert.ok(extension, 'development extension is registered');
  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('idlepage.showBrowser'));
  assert.ok(commands.includes('idlepage.hideBrowser'));
  for (const command of ['nextSegment', 'previousSegment', 'returnReading', 'retryReading', 'toggleReading']) assert.ok(commands.includes('idlepage.' + command));
  const reader = new StatusReader();
  try {
    reader.set('fixture', '一二三四五六七八九十'.repeat(50), 2, 12);
    assert.equal(reader.state().count, '2/12'); assert.equal(reader.state().progress, 0);
    reader.next(); const offset = reader.state().offset; assert.ok(offset > 0);
    const config = vscode.workspace.getConfiguration('idlepage');
    const originalOffset = config.inspect<number>('reading.leftOffsetPercent')?.globalValue;
    try {
      for (const value of [100, 0, 100, 0]) {
        await config.update('reading.leftOffsetPercent', value, vscode.ConfigurationTarget.Global);
        reader.render();
        await new Promise(r => setTimeout(r, 30));
        assert.equal(reader.state().alignment, value === 100 ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left);
        assert.equal(reader.state().offset, offset);
      }
    } finally { await config.update('reading.leftOffsetPercent', originalOffset, vscode.ConfigurationTarget.Global); }
    reader.failure('测试失败'); assert.ok(reader.state().error);
    reader.returnReading(); assert.equal(reader.state().error, undefined); assert.equal(reader.state().offset, offset);
    reader.toggle(); assert.equal(reader.state().hidden, true);
    reader.toggle(); assert.equal(reader.state().offset, offset);
    reader.toggle(); reader.failure('后台失败'); assert.equal(reader.state().hidden, true);
    reader.returnReading(false); reader.set('new-fixture', '后台章节', 3, 12);
    assert.equal(reader.state().hidden, true, 'Background completion must not reveal hidden reading');
    reader.toggle(); assert.equal(reader.state().hidden, false);
  } finally { reader.dispose(); }
  for (const command of menuCommands) assert.ok(commands.includes(command));
  const keybindings = extension.packageJSON.contributes.keybindings;
  assert.equal(keybindings.find((item: { command: string }) => item.command === 'idlepage.toggleReading').when.includes('inputFocus'), false);
  assert.ok(commands.includes('idlepage.openKeybindings'));
  assert.ok(api.getEntryStatus().text.startsWith('$(book)')); assert.equal(api.getEntryStatus().hasClick, false);
  assert.ok(api.getEntryStatus().tooltip.includes('command:idlepage.prepareBrowser'));
  // Logged out everywhere (lazy logins): each area offers only its login entry.
  const a = 'https://example.com/tools/ear/', b = 'https://example.org/vocab/';
  const arg = (url: string) => encodeURIComponent(JSON.stringify([url]));
  const fresh = hoverMenu('就绪', false, undefined, { shelf: false, custom: { practicing: false, sites: [{ url: a, label: 'ear', active: false }] } }).value;
  assert.ok(fresh.includes('command:idlepage.openBookshelf') && fresh.includes('登录起点'));
  for (const hidden of ['refreshBookshelf', 'refreshAll', 'toggleReading', 'retryReading', 'selectReadingLocation', 'study.open', 'study.logout']) assert.ok(!fresh.includes('command:idlepage.' + hidden), hidden);
  // A row per page: its address, then login (signed out), edit and delete for that page.
  assert.ok(fresh.includes('$(link) ear') && fresh.includes(`"${a}"`) && fresh.includes(`command:idlepage.study.login?${arg(a)}`));
  assert.ok(fresh.includes(`command:idlepage.study.setServer?${arg(a)}`) && fresh.includes(`command:idlepage.study.removeSite?${arg(a)}`));
  assert.ok(fresh.includes('command:idlepage.study.addSite'));
  const empty = hoverMenu('就绪', false, undefined, { shelf: false, custom: { practicing: false, sites: [] } }).value;
  assert.ok(empty.includes('command:idlepage.study.addSite') && !empty.includes('command:idlepage.study.login'));
  const hover = hoverMenu('[bad](command:evil)', true, undefined, { shelf: true, custom: { practicing: true, sites: [
    { url: a, label: 'ear', account: 'reader', active: true }, { url: b, label: 'vocab', active: false }] } });
  assert.ok(hover.value.includes('reader') && hover.value.includes(`command:idlepage.study.logout?${arg(a)}`) && hover.value.includes(`command:idlepage.study.open?${arg(a)}`));
  assert.ok(hover.value.includes(`command:idlepage.study.login?${arg(b)}`) && !hover.value.includes(`command:idlepage.study.open?${arg(b)}`));
  assert.ok(hover.value.indexOf('$(play) ear') < hover.value.indexOf('$(link) vocab'), 'one row per page, in order; short name, full URL as tooltip');
  assert.deepEqual(hover.isTrusted, { enabledCommands: menuCommands });
  assert.ok(!hover.value.includes('[bad](command:evil)'));
  assert.ok(hover.value.includes('command:idlepage.refreshAll'));
  assert.ok(hover.value.indexOf('command:idlepage.refreshBookshelf') >= 0);
  assert.ok(hover.value.indexOf('command:idlepage.refreshBookshelf') < hover.value.indexOf('command:idlepage.refreshAll'));
  // Reading and the custom site (idlepage/1 practice) are separate areas of the menu.
  const reading = hover.value.indexOf('**阅读**'), custom = hover.value.indexOf('**自定义网站**');
  assert.ok(reading > 0 && custom > reading);
  assert.ok(hover.value.indexOf('command:idlepage.openBookshelf') > reading && hover.value.indexOf('command:idlepage.openBookshelf') < custom);
  assert.ok(hover.value.indexOf('command:idlepage.study.open') > custom && hover.value.indexOf('command:idlepage.study.setServer') > custom);
  await vscode.commands.executeCommand('idlepage.refreshBookshelf');
  assert.equal(api.getBridgeStatus().phase, 'waiting-bookshelf-list');
  await vscode.commands.executeCommand('idlepage.cancelTask');
  assert.equal(api.getBrowserWindowMode(), 'managed');
  const companion = api.getCompanionDirectory();
  const pairing = await readFile(join(companion, 'pairing.js'), 'utf8');
  const token = /export const token = "([a-f0-9]{64})";/.exec(pairing)?.[1];
  assert.ok(token, 'local paired copy contains bridge credential');
  const manifest = JSON.parse(await readFile(join(companion, 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).split('').map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  const endpoint = api.getBridgeStatus().endpoint;
  const headers = { Origin: `chrome-extension://${id}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  await vscode.commands.executeCommand('idlepage.restartProbe');
  const first = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  const report = { state: 'SiteContentVisible', pageKind: 'other', bodyCharacters: 1500, bookLinks: 3, verification: false, tooFrequent: false, captchaFrame: false };
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: first.id, report }) })).status, 200);
  const shelf = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(shelf.kind, 'bookshelf');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: shelf.id, report: { ...report, pageKind: 'bookshelf' } }) })).status, 200);
  assert.equal(api.getBridgeStatus().phase, 'probe-complete');
  await vscode.commands.executeCommand('idlepage.restartProbe');
  assert.equal(api.getBridgeStatus().phase, 'waiting-access');
  await vscode.commands.executeCommand('idlepage.extractBookshelf');
  const listTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(listTask.kind, 'bookshelf-list');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: listTask.id, report: { ...report, pageKind: 'bookshelf' } }) })).status, 200);
  const page = { books: [{ id: '123', title: 'Fixture book', url: 'https://www.qidian.com/book/123/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: ['table'] };
  const result = await fetch(endpoint + '/v1/bookshelf/result', { method: 'POST', headers, body: JSON.stringify({ taskId: listTask.id, report: page }) });
  assert.equal(result.status, 200);
  assert.ok(!(await result.text()).includes('Fixture book'));
  assert.equal(api.getBridgeStatus().phase, 'bookshelf-page-ready');
  await vscode.commands.executeCommand('idlepage.showBookshelf');
  await vscode.commands.executeCommand('idlepage.extractCatalog');
  const catalogTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(catalogTask.kind, 'catalog');
  assert.equal(catalogTask.bookId, '123');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: catalogTask.id, report: { ...report, pageKind: 'book', bookLinks: 0 } }) })).status, 200);
  const catalog = { bookId: '123', offset: 0, total: 2, declaredCount: 2, truncated: false, strategy: 'catalog-container', chapters: [{ id: '11', title: 'Fixture chapter', url: 'https://www.qidian.com/chapter/123/11/', volume: 'Fixture volume', payment: 'free' }, { id: '12', title: 'Fixture next chapter', url: 'https://www.qidian.com/chapter/123/12/', volume: 'Fixture volume', payment: 'unknown' }] };
  const catalogReply = await fetch(endpoint + '/v1/catalog/result', { method: 'POST', headers, body: JSON.stringify({ taskId: catalogTask.id, report: catalog }) });
  assert.equal(catalogReply.status, 200);
  assert.ok(!(await catalogReply.text()).includes('Fixture chapter'));
  assert.equal(api.getBridgeStatus().phase, 'catalog-preview-ready');
  await vscode.commands.executeCommand('idlepage.showCatalog');
  await vscode.commands.executeCommand('idlepage.extractChapter');
  const chapterTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(chapterTask.kind, 'chapter');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: chapterTask.id, report: { ...report, pageKind: 'chapter', bookLinks: 0 } }) })).status, 200);
  const body = 'Fixture chapter body. '.repeat(70);
  const bodyReply = await fetch(endpoint + '/v1/chapter/result', { method: 'POST', headers, body: JSON.stringify({ taskId: chapterTask.id, report: { status: 'available', offset: 0, total: body.length, text: body } }) });
  assert.equal(bodyReply.status, 200); assert.ok(!(await bodyReply.text()).includes(body));
  assert.equal(api.getBridgeStatus().phase, 'chapter-preview-ready'); await vscode.commands.executeCommand('idlepage.showChapter');
  // Switch back to the ordinary UI flow, retaining the last readable chapter.
  await vscode.commands.executeCommand('idlepage.refreshBookshelf');
  await vscode.commands.executeCommand('idlepage.cancelTask');
  assert.equal(api.getReaderStatus().count, '1/2'); assert.equal(api.getReaderStatus().progress, 0);
  assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'started');
  const deniedTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(deniedTask.url, catalog.chapters[1].url);
  assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'busy');
  assert.equal((await fetch(endpoint + '/v1/chapter/result', { method: 'POST', headers, body: JSON.stringify({ taskId: deniedTask.id, report: { status: 'unavailable', reason: 'locked' } }) })).status, 200);
  assert.equal(api.getBridgeStatus().phase, 'chapter-unavailable');
  assert.ok(api.getReaderStatus().error); const retainedOffset = api.getReaderStatus().offset;
  await vscode.commands.executeCommand('idlepage.returnReading');
  assert.equal(api.getReaderStatus().error, undefined); assert.equal(api.getReaderStatus().offset, retainedOffset);
  const beforeLocationSwitch = api.getReaderStatus();
  for (const location of ['panel', 'sidebar', 'statusBar']) {
    await vscode.workspace.getConfiguration('idlepage').update('reading.location', location, vscode.ConfigurationTarget.Global);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(api.getReaderStatus(), beforeLocationSwitch, 'Changing display location must retain reading state');
    await vscode.commands.executeCommand('idlepage.toggleReading');
    const hidden = api.getReaderStatus(); assert.equal((hidden as { hidden?: boolean }).hidden, true);
    await vscode.commands.executeCommand('idlepage.nextSegment');
    await vscode.commands.executeCommand('idlepage.previousSegment');
    assert.deepEqual(api.getReaderStatus(), hidden, 'Navigation cannot advance hidden reading');
    await vscode.commands.executeCommand('idlepage.toggleReading');
    assert.deepEqual(api.getReaderStatus(), beforeLocationSwitch, 'Restore retains chapter and offset in every location');
    assert.equal((await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task, null);
  }
  assert.equal((await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task, null);
  assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'started');
  const retryTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(retryTask.url, deniedTask.url);
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: retryTask.id, report: { ...report, pageKind: 'chapter', bookLinks: 0 } }) })).status, 200);
  assert.equal((await fetch(endpoint + '/v1/chapter/result', { method: 'POST', headers, body: JSON.stringify({ taskId: retryTask.id, report: { status: 'available', offset: 0, total: body.length, text: body } }) })).status, 200);
  assert.equal(api.getReaderStatus().count, '2/2'); assert.equal(api.getReaderStatus().progress, 0);
  assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'end');
  await vscode.commands.executeCommand('idlepage.extractChapter');
  const pending = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: pending.id, report: { ...report, state: 'NeedsLogin', pageKind: 'login' } }) });
  assert.equal(api.getBridgeStatus().phase, 'waiting-login');
  const loginTask = (await (await fetch(endpoint + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: loginTask.id, report: { ...report, pageKind: 'bookshelf' } }) });
  assert.equal(api.getBridgeStatus().phase, 'waiting-login');
  await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: loginTask.id, report: { ...report, pageKind: 'bookshelf', loginEvidence: 'bookshelf-content' } }) });
  assert.equal(api.getBridgeStatus().phase, 'waiting-chapter');
  assert.equal(await vscode.commands.executeCommand('idlepage.cancelTask'), true);
  assert.equal(api.getBridgeStatus().phase, 'cancelled');
  assert.equal((await fetch(endpoint + '/v1/tasks/result', { method: 'POST', headers, body: JSON.stringify({ taskId: loginTask.id, report }) })).status, 409);
  await vscode.commands.executeCommand('idlepage.returnReading');
  await vscode.commands.executeCommand('idlepage.nextSegment');
  const savedOffset = api.getReaderStatus().offset;
  assert.ok(savedOffset > 0);
  let persisted = false;
  for (let i = 0; i < 100; i++) {
    const saved = await readFile(join(dirname(companion), 'reading-progress.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (saved?.books?.some((b: { bookId: string; chapterId: string; offset: number }) => b.bookId === '123' && b.chapterId === '12' && b.offset === savedOffset)) { persisted = true; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(persisted, 'reading position reached the private on-disk metadata file');
  await writeFile(join(extension.extensionPath, '.local/resume-expected.json'), JSON.stringify({ offset: savedOffset, body }));
  console.log('IdlePage extension-host smoke test passed; saved synthetic reading offset for restart test.');
}
