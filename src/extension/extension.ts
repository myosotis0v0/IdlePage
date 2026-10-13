import * as vscode from 'vscode';
import { chapterPreview, chapterFailureMessage } from '../ui/chapterPreview';
import { catalogPreview } from '../ui/catalogPreview';
import { bookshelfPreview } from '../ui/bookshelfPreview';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { QidianAccessProbe } from '../application/QidianAccessProbe';
import { LocalBridgeServer } from '../infrastructure/local-bridge/LocalBridgeServer';
import { prepareCompanion, readCompanionOrigin } from '../infrastructure/local-bridge/prepareCompanion';
import { openEdgeExtensions } from '../infrastructure/qidian/openEdgeExtensions';

let bridge: LocalBridgeServer | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('IdlePage');
  const status = vscode.window.createStatusBarItem('idlepage.connection', vscode.StatusBarAlignment.Left, 0);
  status.command = 'idlepage.showStatus';
  status.text = 'IdlePage: 启动中'; status.show();
  context.subscriptions.push(output, status);
  const storage = context.globalStorageUri.fsPath;
  const probe = new QidianAccessProbe();
  let reportWrites = Promise.resolve();
  let lastDisplay = '';
  let bookshelfShown = false;
  let catalogShown = false;
  let chapterShown = false;
  let chapterPanel: vscode.WebviewPanel | undefined;
  let catalogPanel: vscode.WebviewPanel | undefined;
  let preview: vscode.WebviewPanel | undefined;
  const showBookshelf = () => {
    const page = probe.getBookshelf();
    if (!page) { void vscode.window.showInformationMessage('尚未收到当前页书单。'); return; }
    if (!preview) {
      preview = vscode.window.createWebviewPanel('idlepage.bookshelf', 'IdlePage：当前页书单', vscode.ViewColumn.Active, { enableScripts: false });
      preview.onDidDispose(() => { preview = undefined; });
      context.subscriptions.push(preview);
    }
    preview.webview.html = bookshelfPreview(page); preview.reveal();
  };
  const showCatalog = () => {
    const catalog = probe.getCatalog();
    if (!catalog || probe.snapshot().phase !== 'catalog-preview-ready') { void vscode.window.showInformationMessage('尚未收到完整的本次目录结果。'); return; }
    if (!catalogPanel) {
      catalogPanel = vscode.window.createWebviewPanel('idlepage.catalog', 'IdlePage：目录核对', vscode.ViewColumn.Active, { enableScripts: false });
      catalogPanel.onDidDispose(() => { catalogPanel = undefined; }); context.subscriptions.push(catalogPanel);
    }
    const title = probe.getBookshelf()?.books.find(book => book.id === catalog.bookId)?.title ?? catalog.bookId;
    catalogPanel.webview.html = catalogPreview(catalog, title); catalogPanel.reveal();
  };
  const showChapter = () => {
    const result = probe.getChapter(); const reading = probe.getReadingChapter();
    if (!result && !reading) { void vscode.window.showInformationMessage('尚未收到正文获取结果。'); return; }
    if (!chapterPanel) {
      chapterPanel = vscode.window.createWebviewPanel('idlepage.chapter', 'IdlePage：正文核对', vscode.ViewColumn.Active, { enableScripts: false, enableCommandUris: ['idlepage.nextChapter'] });
      chapterPanel.onDidDispose(() => { chapterPanel = undefined; }); context.subscriptions.push(chapterPanel);
    }
    const notice = result?.status === 'unavailable' ? chapterFailureMessage[result.reason] : undefined;
    chapterPanel.webview.html = chapterPreview(reading ?? result!, reading ? probe.snapshot().chapterNavigation : undefined, notice); chapterPanel.reveal();
  };
  const update = () => {
    const snapshot = probe.snapshot();
    const state = snapshot.report?.state;
    const display = state === 'AccessBlocked' ? '访问受阻' : state === 'NeedsLogin' ? '需要登录' :
      snapshot.phase === 'chapter-preview-ready' ? `正文 ${snapshot.chapterSummary?.characters ?? 0} 字符待核对` :
      snapshot.phase === 'chapter-unavailable' ? '正文暂不可获取' :
      ['waiting-chapter', 'receiving-chapter'].includes(snapshot.phase) ? '正在获取正文' :
      snapshot.phase === 'catalog-preview-ready' ? `目录 ${snapshot.catalogSummary?.count ?? 0} 章待核对` :
      snapshot.phase === 'catalog-not-ready' ? '尚未找到目录章节' :
      snapshot.phase === 'waiting-catalog' ? '正在打开目录' :
      snapshot.phase === 'receiving-catalog' ? `目录 ${snapshot.catalogSummary?.count}/${snapshot.catalogSummary?.total}` :
      snapshot.bookshelfSummary ? `书单 ${snapshot.bookshelfSummary.count} 本待核对` : snapshot.phase === 'probe-complete' ? '书架访问完成' :
      snapshot.lastSeenAt ? '浏览器已连接' : '等待浏览器';
    if (snapshot.phase === 'catalog-preview-ready' && !catalogShown) { catalogShown = true; showCatalog(); }
    if (['chapter-preview-ready', 'chapter-unavailable'].includes(snapshot.phase) && !chapterShown) {
      chapterShown = true; showChapter(); const result = probe.getChapter();
      if (result?.status === 'unavailable') void vscode.window.showWarningMessage(chapterFailureMessage[result.reason]);
    }
    if (snapshot.bookshelfSummary && !bookshelfShown && !/catalog|chapter/.test(snapshot.phase)) { bookshelfShown = true; showBookshelf(); }
    status.text = `IdlePage: ${display}`;
    status.tooltip = '起点接入验证：点击查看连接状态';
    if (display !== lastDisplay) { output.appendLine(display); lastDisplay = display; }
    reportWrites = reportWrites.then(() => writeFile(join(storage, 'bridge-report.json'), JSON.stringify(snapshot, null, 2) + '\n')).catch(() => { output.appendLine('状态记录写入失败'); });
  };
  try {
    await mkdir(storage, { recursive: true });
    let token = await context.secrets.get('idlepage.bridge.token');
    if (!token) { token = randomBytes(32).toString('hex'); await context.secrets.store('idlepage.bridge.token', token); }
    const port = vscode.workspace.getConfiguration('idlepage').get<number>('bridge.port', 17655);
    const origin = await readCompanionOrigin(context.extensionPath);
    bridge = new LocalBridgeServer({ port, token, origin, probe, onChanged: update,
      onRejected: (reason, method) => {
        // Coarse diagnostic only: never record headers, credentials, bodies or account information.
        void writeFile(join(storage, 'bridge-diagnostics.json'), JSON.stringify({ reason, method, observedAt: new Date().toISOString() })).catch(() => {});
      },
    });
    await bridge.start();
    // Do not overwrite a running window's paired copy when binding fails.
    const companion = await prepareCompanion(context.extensionPath, storage, bridge.endpoint(), token);
    update();
    output.appendLine(`本机服务：${bridge.endpoint()}`);
    output.appendLine(`浏览器辅助扩展目录：${companion.directory}`);
    context.subscriptions.push(
      vscode.commands.registerCommand('idlepage.showStatus', () => {
        output.appendLine(JSON.stringify(probe.snapshot(), null, 2)); output.show(true);
      }),
      vscode.commands.registerCommand('idlepage.prepareBrowser', async () => {
        try {
          await openEdgeExtensions();
          await vscode.env.clipboard.writeText(companion.directory);
          output.show(true);
          void vscode.window.showInformationMessage('浏览器扩展目录已复制。在 Edge 开发人员模式中加载该目录；安装后自动连接。');
        } catch { void vscode.window.showErrorMessage('无法打开 Edge，请手动在普通 Edge 中加载 IdlePage 浏览器辅助扩展。'); output.show(true); }
      }),
      vscode.commands.registerCommand('idlepage.restartProbe', () => { probe.restart(); update(); }),
      vscode.commands.registerCommand('idlepage.extractBookshelf', () => { bookshelfShown = false; probe.startBookshelfExtraction(); update(); }),
      vscode.commands.registerCommand('idlepage.showBookshelf', showBookshelf),
      vscode.commands.registerCommand('idlepage.extractCatalog', () => { catalogShown = false; probe.startCatalogExtraction(); update(); }),
      vscode.commands.registerCommand('idlepage.showCatalog', showCatalog),
      vscode.commands.registerCommand('idlepage.extractChapter', () => { chapterShown = false; probe.startChapterExtraction(); update(); }),
      vscode.commands.registerCommand('idlepage.showChapter', showChapter),
      vscode.commands.registerCommand('idlepage.nextChapter', () => {
        const result = probe.startNextChapter();
        if (result !== 'started') {
          void vscode.window.showInformationMessage({ busy: '正在获取章节，请稍候。', 'not-ready': '请先获取当前章正文。', end: '本次目录没有下一章。' }[result]); return result;
        }
        chapterShown = false; showChapter(); update(); return result;
      }),
    );
    const expiryTimer = setInterval(() => { if (probe.expireChapter()) update(); }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(expiryTimer) });
    return { getBridgeStatus: () => ({ endpoint: bridge!.endpoint(), ...probe.snapshot() }), getCompanionDirectory: () => companion.directory };
  } catch (error) {
    await bridge?.close(); bridge = undefined;
    const code = (error as NodeJS.ErrnoException).code;
    status.text = 'IdlePage: 连接服务未启动';
    output.appendLine(code === 'EADDRINUSE' ? '本机端口已占用。当前原型只支持一个活动服务窗口。' : '本机服务启动失败。');
    throw new Error(code === 'EADDRINUSE' ? 'IdlePagePortInUse' : 'IdlePageBridgeStartupFailed');
  }
}
export async function deactivate(): Promise<void> { await bridge?.close(); bridge = undefined; }
