import * as vscode from 'vscode';
import { chapterPreview, chapterFailureMessage } from '../ui/chapterPreview';
import { catalogPreview } from '../ui/catalogPreview';
import { bookshelfPreview } from '../ui/bookshelfPreview';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { QidianAccessProbe } from '../application/QidianAccessProbe';
import { BrowserSession } from '../application/BrowserSession';
import { BrowserWindowController } from '../application/BrowserWindowController';
import { BrowserVisibility } from '../application/BrowserVisibility';
import { EdgeWindowControl } from '../infrastructure/qidian/EdgeWindowControl';
import { EdgeLifetime } from '../infrastructure/qidian/EdgeLifetime';
import { LocalBridgeServer } from '../infrastructure/local-bridge/LocalBridgeServer';
import { prepareCompanion, readCompanionOrigin, readExistingPairingToken } from '../infrastructure/local-bridge/prepareCompanion';
import { openEdgeExtensions, openEdgeCompanion } from '../infrastructure/qidian/openEdgeExtensions';

let bridge: LocalBridgeServer | undefined;
let stopBrowser: (() => Promise<void>) | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('IdlePage');
  const status = vscode.window.createStatusBarItem('idlepage.connection', vscode.StatusBarAlignment.Left, 0);
  status.command = 'idlepage.showStatus';
  status.text = 'IdlePage: 启动中'; status.show();
  context.subscriptions.push(output, status);
  const storage = context.globalStorageUri.fsPath;
  const probe = new QidianAccessProbe();
  const lifetime = new EdgeLifetime(storage);
  const browserWindows = new BrowserWindowController(new EdgeWindowControl());
  let manageVisibility = false;
  let visibilityKey = '';
  const visibility = new BrowserVisibility({ windows: browserWindows,
    canHide: () => manageVisibility && vscode.workspace.getConfiguration('idlepage').get<boolean>('browser.autoHide', true) &&
      !['NeedsLogin', 'AccessBlocked'].includes(probe.snapshot().report?.state ?? ''),
    onFailure: () => { output.appendLine('辅助浏览器自动隐藏未完成'); void vscode.window.showWarningMessage('辅助浏览器未能自动隐藏，可使用显示/隐藏命令排查。读取任务继续执行。'); },
  });
  context.subscriptions.push({ dispose: () => visibility.dispose() });
  let browserSession: BrowserSession | undefined;
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
    const snapshot = { ...probe.snapshot(), browserConnection: browserSession?.state,
      browserWindow: { mode: browserWindows.mode, lastAutomaticControl: visibility.lastResult } };
    const state = snapshot.report?.state;
    const nextVisibilityKey = `${probe.currentTaskId() ?? ''}:${state ?? ''}`;
    if (manageVisibility && vscode.workspace.getConfiguration('idlepage').get<boolean>('browser.autoHide', true) && nextVisibilityKey !== visibilityKey) {
      visibilityKey = nextVisibilityKey;
      if (state === 'NeedsLogin') {
        void browserWindows.revealForAttention().then(result => {
          if (result.status !== 'ok') void vscode.window.showWarningMessage('需要登录，但无法显示辅助浏览器，请使用“显示辅助浏览器”排查。');
        }).catch(() => { void vscode.window.showWarningMessage('需要登录，请使用“显示辅助浏览器”排查。'); });
      } else if (state !== 'AccessBlocked') void visibility.requestHide();
    }
    const display = state === 'AccessBlocked' ? '访问受阻' : state === 'NeedsLogin' ? '需要登录' :
      browserSession?.state === 'failed' ? '浏览器连接失败' :
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
    const secretToken = await context.secrets.get('idlepage.bridge.token');
    // Preserve the credential already installed in this window's private paired
    // copy, including when isolated host SecretStorage is not restored.
    let token = await readExistingPairingToken(storage) ?? secretToken;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) token = randomBytes(32).toString('hex');
    if (secretToken !== token) await context.secrets.store('idlepage.bridge.token', token);
    const port = vscode.workspace.getConfiguration('idlepage').get<number>('bridge.port', 17655);
    const origin = await readCompanionOrigin(context.extensionPath);
    bridge = new LocalBridgeServer({ port, token, origin, probe, onChanged: update,
      onContact: () => browserSession?.noteContact(),
      onRejected: (reason, method) => {
        // Coarse diagnostic only: never record headers, credentials, bodies or account information.
        void writeFile(join(storage, 'bridge-diagnostics.json'), JSON.stringify({ reason, method, observedAt: new Date().toISOString() })).catch(() => {});
      },
    });
    await bridge.start();
    // Do not overwrite a running window's paired copy when binding fails.
    const companion = await prepareCompanion(context.extensionPath, storage, bridge.endpoint(), token);
    browserSession = new BrowserSession({ launch: async () => {
      await lifetime.launch(() => openEdgeCompanion(origin));
      void visibility.requestHide();
    }, isCurrent: id => probe.isCurrentTask(id), hasObserved: id => probe.hasObservedTask(id), onChanged: update });
    context.subscriptions.push({ dispose: () => browserSession?.dispose() });
    stopBrowser = async () => { visibility.dispose(); browserSession?.dispose(); await lifetime.stop(); };
    const ensureBrowser = () => {
      const id = probe.currentTaskId();
      if (!id) return;
      const config = vscode.workspace.getConfiguration('idlepage');
      if (!config.get<boolean>('browser.autoStart', true) && !config.get<boolean>('browser.autoHide', true)) return;
      void lifetime.start().then(async () => {
        manageVisibility = true; void visibility.requestHide();
        if (!config.get<boolean>('browser.autoStart', true)) return;
        const result = await browserSession!.ensure(id);
        if (result === 'launch-failed') void vscode.window.showWarningMessage('无法启动专用 Edge，请确认 Microsoft Edge 已安装。当前正文已保留。');
        if (result === 'connection-timeout') void vscode.window.showWarningMessage('浏览器未能执行任务。请检查专用 Edge 中 IdlePage Browser Companion 是否已安装并启用；首次安装请运行“准备浏览器连接”。当前正文已保留。');
      }).catch(() => { void vscode.window.showWarningMessage('无法接管专用浏览器的生命周期，请关闭其他 IdlePage 服务窗口后重试。'); });
    };
    update();
    output.appendLine(`本机服务：${bridge.endpoint()}`);
    output.appendLine(`浏览器辅助扩展目录：${companion.directory}`);
    const controlBrowserWindow = async (action: 'show' | 'hide') => {
      try {
        await lifetime.start();
        const result = await (action === 'show' ? browserWindows.show() : browserWindows.hide());
        if (result.status === 'ok') {
          void vscode.window.showInformationMessage(action === 'show' ? '已显示辅助浏览器，进入排查状态。执行“隐藏辅助浏览器”可恢复自动管理。' : '已隐藏辅助浏览器；浏览器仍在运行。');
        } else {
          const messages = { 'not-running': '专用 Edge 尚未运行，请先发起读取任务或运行“准备浏览器连接”。',
            'no-window': '专用 Edge 当前没有可控制的窗口，请稍后重试。',
            ambiguous: '无法唯一识别 IdlePage 专用 Edge，未更改窗口。', failed: '辅助浏览器窗口控制未完成，请稍后重试。' };
          void vscode.window.showWarningMessage(messages[result.status]);
        }
        output.appendLine(`浏览器窗口：${action} / ${result.status}`);
        return result.status;
      } catch {
        output.appendLine('浏览器窗口控制失败');
        void vscode.window.showWarningMessage('无法控制辅助浏览器窗口，请确认正在 Windows 桌面环境运行。');
        return 'failed';
      }
    };
    context.subscriptions.push(
      vscode.commands.registerCommand('idlepage.showBrowser', () => controlBrowserWindow('show')),
      vscode.commands.registerCommand('idlepage.hideBrowser', () => controlBrowserWindow('hide')),
      vscode.commands.registerCommand('idlepage.showStatus', () => {
        output.appendLine(JSON.stringify(probe.snapshot(), null, 2)); output.show(true);
      }),
      vscode.commands.registerCommand('idlepage.prepareBrowser', async () => {
        try {
          await lifetime.launch(openEdgeExtensions);
          await vscode.env.clipboard.writeText(companion.directory);
          output.show(true);
          void vscode.window.showInformationMessage('浏览器扩展目录已复制。在 Edge 开发人员模式中加载该目录；安装后自动连接。');
        } catch { void vscode.window.showErrorMessage('无法打开 Edge，请手动在普通 Edge 中加载 IdlePage 浏览器辅助扩展。'); output.show(true); }
      }),
      vscode.commands.registerCommand('idlepage.restartProbe', () => { probe.restart(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.extractBookshelf', () => { bookshelfShown = false; probe.startBookshelfExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showBookshelf', showBookshelf),
      vscode.commands.registerCommand('idlepage.extractCatalog', () => { catalogShown = false; probe.startCatalogExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showCatalog', showCatalog),
      vscode.commands.registerCommand('idlepage.extractChapter', () => { chapterShown = false; probe.startChapterExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showChapter', showChapter),
      vscode.commands.registerCommand('idlepage.nextChapter', () => {
        const result = probe.startNextChapter();
        if (result !== 'started') {
          void vscode.window.showInformationMessage({ busy: '正在获取章节，请稍候。', 'not-ready': '请先获取当前章正文。', end: '本次目录没有下一章。' }[result]); return result;
        }
        chapterShown = false; showChapter(); update(); ensureBrowser(); return result;
      }),
    );
    const expiryTimer = setInterval(() => { if (probe.expireChapter()) update(); }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(expiryTimer) });
    return { getBridgeStatus: () => ({ endpoint: bridge!.endpoint(), ...probe.snapshot() }), getCompanionDirectory: () => companion.directory,
      getBrowserWindowMode: () => browserWindows.mode };
  } catch (error) {
    await bridge?.close(); bridge = undefined;
    const code = (error as NodeJS.ErrnoException).code;
    status.text = 'IdlePage: 连接服务未启动';
    output.appendLine(code === 'EADDRINUSE' ? '本机端口已占用。当前原型只支持一个活动服务窗口。' : '本机服务启动失败。');
    throw new Error(code === 'EADDRINUSE' ? 'IdlePagePortInUse' : 'IdlePageBridgeStartupFailed');
  }
}
export async function deactivate(): Promise<void> {
  const cleanup = stopBrowser; stopBrowser = undefined;
  try { await bridge?.close(); }
  finally { bridge = undefined; await cleanup?.(); }
}
