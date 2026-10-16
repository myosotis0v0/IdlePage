import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { readCompanionOrigin } from '../../src/infrastructure/local-bridge/prepareCompanion';

type Row = Array<{ text: string; command?: string }>;
interface Exports { getBridgeStatus(): { endpoint: string }; getCompanionDirectory(): string; getStudyRow(): Row; getEntryStatus(): { tooltip: string } }
const until = async (check: () => boolean, label: string, ms = 8000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(r => setTimeout(r, 25));
  assert.ok(check(), label);
};

/**
 * Real host, real commands and status bar: this test plays the browser companion on the
 * loopback bridge and answers its jobs from a minimal idlepage/1 site.
 */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  const site = createServer((req, res) => {
    const json = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = req.url ?? '';
    if (url === '/.well-known/idlepage.json') return json({ protocol: 'idlepage/1', name: '示例站', login: '/login', account: '/api/me', study: '/api/study/' });
    if (url === '/api/me') return json({ username: 'reader' });
    if (url === '/api/study/banks') return json({ banks: [{ id: 'ear', title: '练耳', page: '/tools/ear/', player: '/tools/ear/player.html' }, { id: 'words', title: '单词', page: '/tools/words/' }] });
    if (url === '/api/study/banks/ear') return json({ units: [] });
    if (url.startsWith('/api/study/banks/ear/progress')) return json({});
    if (url === '/api/study/banks/ear/next') return json({ lesson: { unit: null }, questions: [
      { qid: 'q1', view: { prompt: '这两个音隔了多远？', audio: [{ label: '再听一遍', src: 'banks/ear/audio/q1' }], answer: { type: 'choice', choices: [{ id: '7', label: '纯五度', detail: 'P5' }, { id: '12', label: '纯八度', detail: '两个音同名，高一个八度' }], correct: '7', reveal: 'A3 → E4' } } },
      { qid: 'r1', view: { prompt: '是哪一小节？', answer: { type: 'choice', choices: [{ id: 'a', label: '●○○○ ●○●○' }, { id: 'b', label: '●○●○ ●○○○' }], correct: 'a' } } },
      { qid: 'q2', view: { prompt: '就任', answer: { type: 'self', back: 'しゅうにん　上任', grades: [{ rating: 1, label: '不认识', again: true }, { rating: 3, label: '认识', hint: '3 天' }] } } }] });
    if (url === '/api/study/banks/ear/results') return json({ summary: '首答 1/1 · +6 经验' });
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const config = vscode.workspace.getConfiguration('idlepage');
  const played: string[] = [];
  let polling = true;
  try {
    // Two practice pages on one site: the lesson runs on the one picked from its row.
    await config.update('remote.servers', [origin + '/tools/ear/', origin + '/tools/words/'], vscode.ConfigurationTarget.Global);
    // The companion: long-poll the bridge, run each job against the site, post the result back.
    const pairing = JSON.parse(await readFile(join(api.getCompanionDirectory(), 'pairing.json'), 'utf8'));
    const headers = { Authorization: `Bearer ${pairing.token}`, Origin: await readCompanionOrigin(extension.extensionPath), 'Content-Type': 'application/json' };
    const companion = (async () => {
      while (polling) {
        const reply = await (await fetch(api.getBridgeStatus().endpoint + '/v1/remote/next', { method: 'POST', headers, body: '{}' })).json() as { request?: Record<string, string> };
        const job = reply.request; if (!job) continue;
        let result: unknown = { ok: true };
        if (job.op === 'fetch') { const r = await fetch(job.origin + job.path, { method: job.method, body: job.body, headers: { 'Content-Type': 'application/json' } }); result = { status: r.status, text: await r.text() }; }
        if (job.op === 'play') { played.push(job.path); result = { status: 200, played: true }; }
        await fetch(api.getBridgeStatus().endpoint + '/v1/remote/result', { method: 'POST', headers, body: JSON.stringify({ id: job.id, result }) });
      }
    })();
    const texts = () => api.getStudyRow().map(slot => slot.text);
    await new Promise(r => setTimeout(r, 300));

    // One bank on this practice page: the lesson starts directly; the card is in the bar, not in a hover.
    await vscode.commands.executeCommand('idlepage.study.open', origin + '/tools/ear/');
    await until(() => texts().some(t => t.includes('这两个音隔了多远')), 'prompt shown in the status bar');
    assert.deepEqual(texts(), ['$(mortar-board) 1/3', '这两个音隔了多远？', '① 纯五度·P5', '② 纯八度', '$(unmute)', '$(close)']);
    assert.deepEqual(api.getStudyRow().slice(2, 4).map(s => s.command), ['idlepage.study.option', 'idlepage.study.option']);
    await until(() => played.length === 1, 'question audio autoplayed');
    // The book hover lists one row per page; the page in use now shows its account (proved by this request).
    const menu = api.getEntryStatus().tooltip;
    const ear = menu.indexOf('/tools/ear'), words = menu.indexOf('/tools/words');
    assert.ok(ear > 0 && words > ear, 'one row per configured page');
    assert.ok(menu.slice(ear, words).includes('reader') && menu.slice(ear, words).includes('command:idlepage.study.logout'));
    assert.ok(menu.slice(words).includes('reader'), 'pages on the same site share its login');

    // Wrong: the card stays, the correct option is marked, only ✗ appears at the right end.
    await vscode.commands.executeCommand('idlepage.study.option', 2);
    assert.deepEqual(texts(), ['$(mortar-board) 1/3', '这两个音隔了多远？', '$(check) ① 纯五度·P5', '$(close) ② 纯八度', '$(unmute)', '$(error)', '$(close)']);
    await vscode.commands.executeCommand('idlepage.study.option', 1); // any option continues
    // Step-grid rhythm labels render as equal-width ◆/◇ (no codicon padding), one space between beats.
    assert.deepEqual(texts(), ['$(mortar-board) 2/3', '是哪一小节？',
      '① ◆◇◇◇ ◆◇◆◇',
      '② ◆◇◆◇ ◆◇◇◇', '$(error)', '$(close)']);
    // Right: straight to the next card, only ✓ at the right end.
    await vscode.commands.executeCommand('idlepage.study.option', 1);
    assert.deepEqual(texts(), ['$(mortar-board) 3/3', '就任', '$(eye) 翻开', '$(pass)', '$(close)']);
    await vscode.commands.executeCommand('idlepage.study.primary');
    assert.deepEqual(texts(), ['$(mortar-board) 3/3', '就任 → しゅうにん　上任', '① 不认识', '② 认识·3 天', '$(pass)', '$(close)']);
    await vscode.commands.executeCommand('idlepage.study.option', 2);
    await until(() => texts()[0]?.startsWith('$(check)'), 'lesson submitted');
    assert.deepEqual(texts(), ['$(check) 练耳 · 首答 1/1 · +6 经验', '$(debug-restart) 再来一组', '$(list-selection) 换', '$(close)']);
    await vscode.commands.executeCommand('idlepage.study.stop');
    assert.deepEqual(texts(), []);
    console.log('Study host test passed: card, choices, grades, feedback and summary are all status-bar items.');
  } finally {
    polling = false;
    await config.update('remote.servers', undefined, vscode.ConfigurationTarget.Global);
    site.closeAllConnections(); site.close();
  }
}
