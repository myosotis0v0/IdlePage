import { ReadingDemo } from '../ui/ReadingDemo';
import { SetupGuide } from '../application/SetupGuide';
import { ReadingLocation } from '../ui/ReadingLocation';
import { StatusReader } from '../ui/StatusReader';
import { ReadingPrefetch } from '../application/ReadingPrefetch';
import { ReadingProgress, type Bookmark } from '../application/ReadingProgress';
import { openProgressStorage } from '../infrastructure/cache/ProgressStorage';
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
import { ReadingCache } from '../infrastructure/cache/ReadingCache';
import { hoverMenu, Navigation } from '../ui/navigation';
import { LocalBridgeServer } from '../infrastructure/local-bridge/LocalBridgeServer';
import { prepareCompanion, readCompanionOrigin, readExistingPairingToken } from '../infrastructure/local-bridge/prepareCompanion';
import { openEdgeExtensions, openDedicatedEdge, setCompanionDirectory } from '../infrastructure/qidian/openEdgeExtensions';
import { RemoteChannel } from '../infrastructure/local-bridge/RemoteChannel';
import { RemoteClient } from '../application/RemoteClient';
import { serverAddress } from '../domain/remoteProtocol';
import { StudyController, type CustomSiteState } from '../ui/Study';

let bridge: LocalBridgeServer | undefined;
let stopBrowser: (() => Promise<void>) | undefined;
export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('idlepage.readingDemo', new ReadingDemo(), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('idlepage.openReadingDemo', () => vscode.commands.executeCommand('idlepage.readingDemo.focus')));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('idlepage.sidebarReadingDemo', new ReadingDemo(true), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('idlepage.openSidebarReadingDemo', async () => {
      if (!vscode.extensions.getExtension('openai.chatgpt')) throw new Error('CodexExtensionRequired');
      await vscode.commands.executeCommand('chatgpt.sidebarSecondaryView.focus');
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['idlepage.sidebarReadingDemo'], destinationId: 'workbench.view.extension.codexSecondaryViewContainer' });
      await vscode.commands.executeCommand('idlepage.sidebarReadingDemo.focus');
      await new Promise(resolve => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('setContext', 'focusedView', 'idlepage.sidebarReadingDemo');
      try { await vscode.commands.executeCommand('views.moveViewUp'); } finally { await vscode.commands.executeCommand('idlepage.sidebarReadingDemo.focus'); }
    }));
  const output = vscode.window.createOutputChannel('IdlePage');
  const reader = new StatusReader(); context.subscriptions.push(reader);
  context.subscriptions.push(new ReadingLocation(reader));
  let prefetch: ReadingPrefetch | undefined;
  let readingRevision = -1;
  let readingFailure: 'prefetch' | 'foreground' = 'prefetch';
  const status = vscode.window.createStatusBarItem('idlepage.connection', vscode.StatusBarAlignment.Left, 0);
  status.name = '余页'; status.accessibilityInformation = { label: '余页，悬停打开功能菜单' };
  status.text = '$(book)'; status.tooltip = hoverMenu('正在启动', false); status.show();
  context.subscriptions.push(output, status);
  const storage = context.globalStorageUri.fsPath;
  const setup = new SetupGuide(context.globalState.get<boolean>('idlepage.setupCompleted', false));
  // With a practice address configured, do not keep advertising the Qidian-oriented first-use guide.
  const cacheEnabled = vscode.workspace.getConfiguration('idlepage').get<boolean>('cache.enabled', true);
  const probe = new QidianAccessProbe(cacheEnabled);
  probe.invalidateTask();
  let cache: ReadingCache | undefined;
  let cachedRevision = 0;
  let checkingTask: string | undefined;
  let ensureBrowser = (_force = false) => {};
  let navigation: Navigation | undefined;
  let diagnosticPreviews = false;
  let selectionEpoch = 0;
  let refreshing = false;
  let shuttingDown = false;
  let cacheWarning = false;
  let lastFailure = 0;
  let customSite: () => CustomSiteState | undefined = () => undefined;
  let displayedBookmark: Pick<Bookmark, 'bookId' | 'chapterId' | 'title'> | undefined;
  let pendingResume: { bookmark: Bookmark; epoch: number; requested: boolean } | undefined;
  let progressWarning = false;
  const progressStorage = await openProgressStorage(storage).catch(() => {
    void vscode.window.showWarningMessage('阅读进度文件无法读取，暂用本机扩展存储。');
    return context.globalState;
  });
  const progress = new ReadingProgress(progressStorage, () => {
    if (!progressWarning) { progressWarning = true; void vscode.window.showWarningMessage('阅读进度保存失败，请检查本机存储。'); }
  });
  void vscode.commands.executeCommand('setContext', 'idlepage.canResume', !!progress.last());
  if (progress.last()) {
    // Existing user bindings may still use the old idlepage.reading condition.
    // Mark saved reading available but hidden, so segment shortcuts stay inactive.
    reader.toggle();
    void vscode.commands.executeCommand('setContext', 'idlepage.reading', true);
  }
  context.subscriptions.push(reader.onDidChange(state => {
    if (!displayedBookmark || !state.count || state.error || pendingResume) return;
    progress.save({ ...displayedBookmark, offset: state.offset, progress: state.progress });
    void vscode.commands.executeCommand('setContext', 'idlepage.canResume', true);
  }));
  const warnCache = () => { if (!cacheWarning) { cacheWarning = true; output.appendLine('本地缓存读写失败，继续在线读取。'); reader.failure('缓存读写失败或空间不足'); } };
  let lifetime = new EdgeLifetime(storage);
  const browserWindows = new BrowserWindowController(new EdgeWindowControl());
  let manageVisibility = false;
  let visibilityKey = '';
  const visibility = new BrowserVisibility({ windows: browserWindows,
    canHide: () => manageVisibility && !refreshing && !shuttingDown && vscode.workspace.getConfiguration('idlepage').get<boolean>('browser.autoHide', true) &&
      !probe.snapshot().recovery.waitingLogin &&
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
      chapterPanel = vscode.window.createWebviewPanel('idlepage.chapter', '余页 · 正文', vscode.ViewColumn.Active, { enableScripts: false, enableCommandUris: ['idlepage.nextChapter'] });
      chapterPanel.onDidDispose(() => { chapterPanel = undefined; }); context.subscriptions.push(chapterPanel);
    }
    const notice = result?.status === 'unavailable' ? chapterFailureMessage[result.reason] : undefined;
    chapterPanel.webview.html = chapterPreview(reading ?? result!, reading ? probe.snapshot().chapterNavigation : undefined, notice, probe.snapshot().chapterSource); chapterPanel.reveal();
  };
  const update = () => {
    const skippedTitle = probe.takeSkipNotice();
    if (skippedTitle !== undefined) vscode.window.setStatusBarMessage(`余页：已跳过加载失败章节「${skippedTitle}」，已接续下一章`, 15000);
    const snapshot = { ...probe.snapshot(), cache: cache?.summary(), browserConnection: browserSession?.state,
      browserWindow: { mode: browserWindows.mode, lastAutomaticControl: visibility.lastResult } };
    if (cache && cachedRevision !== probe.cacheRevision()) {
      cachedRevision = probe.cacheRevision();
      const shelf = probe.getBookshelf(), catalog = probe.getCatalog(), chapter = probe.cacheChapter();
      if (shelf) void cache.saveShelf(shelf).catch(warnCache);
      if (catalog && catalog.chapters.length === catalog.total) void cache.saveCatalog(catalog).catch(warnCache);
      if (chapter) void cache.saveChapter(chapter).then(saved => { if (!saved) warnCache(); }).catch(warnCache);
    }
    if (pendingResume && pendingResume.epoch !== selectionEpoch) pendingResume = undefined;
    if (pendingResume && !pendingResume.requested) {
      const catalog = probe.getCatalog();
      if (catalog?.bookId === pendingResume.bookmark.bookId && catalog.total === catalog.chapters.length) {
        pendingResume.requested = true;
        if (!probe.selectChapter(catalog.bookId, pendingResume.bookmark.chapterId)) {
          pendingResume = undefined; reader.failure('上次阅读的章节不在当前目录中，请重新选章');
        } else { chapterShown = false; ensureBrowser(); }
      }
    }
    const reading = probe.readingContext();
    if (!diagnosticPreviews && reading && reading.revision !== readingRevision) {
      readingRevision = reading.revision; const body = probe.getReadingChapter()!;
      reader.returnReading(false);
      const chapter = reading.catalog.chapters[reading.index];
      const bookmark = pendingResume?.bookmark;
      const resume = bookmark?.bookId === reading.catalog.bookId && bookmark.chapterId === chapter.id;
      displayedBookmark = { bookId: reading.catalog.bookId, chapterId: chapter.id, title: chapter.title };
      pendingResume = undefined;
      reader.set(String(reading.revision), body.text, reading.index + 1, reading.catalog.chapters.length, resume ? bookmark.offset : 0, !!bookmark);
      void vscode.commands.executeCommand('setContext', 'idlepage.reading', true);
    }
    if (!diagnosticPreviews && !refreshing && !shuttingDown) prefetch?.sync();
    const pending = probe.pendingCacheChapter();
    if (pending && checkingTask !== pending.taskId) {
      checkingTask = pending.taskId;
      void (cache?.chapter(pending.bookId, pending.id) ?? Promise.resolve(undefined)).catch(() => { warnCache(); return undefined; }).then(chapter => {
        if (probe.resolveCachedChapter(pending.taskId, chapter)) { update(); ensureBrowser(); }
      });
    }
    const state = snapshot.report?.state;
    const nextVisibilityKey = `${probe.currentTaskId() ?? ''}:${state ?? ''}:${snapshot.phase}`;
    if (manageVisibility && (snapshot.recovery.waitingLogin || vscode.workspace.getConfiguration('idlepage').get<boolean>('browser.autoHide', true)) && nextVisibilityKey !== visibilityKey) {
      visibilityKey = nextVisibilityKey;
      if (snapshot.recovery.waitingLogin) {
        void browserWindows.revealForAttention().then(result => {
          if (result.status !== 'ok') void vscode.window.showWarningMessage('需要登录，但无法显示辅助浏览器，请使用“显示辅助浏览器”排查。');
        }).catch(() => { void vscode.window.showWarningMessage('需要登录，请使用“显示辅助浏览器”排查。'); });
      } else if (state !== 'AccessBlocked') void visibility.requestHide();
    }
    const display = snapshot.phase === 'idle' ? '就绪' : snapshot.recovery.waitingLogin ? '等待手动登录，完成后自动恢复' : snapshot.phase === 'cancelled' ? '已取消获取' : snapshot.phase === 'task-failed' ? '获取已停止' : state === 'AccessBlocked' ? '访问受阻' : state === 'NeedsLogin' ? '需要登录' :
      browserSession?.state === 'failed' ? '浏览器连接失败' :
      snapshot.phase === 'chapter-preview-ready' ? `正文 ${snapshot.chapterSummary?.characters ?? 0} 字符待核对` :
      snapshot.phase === 'chapter-unavailable' ? '正文暂不可获取' :
      ['checking-cache', 'waiting-chapter', 'receiving-chapter'].includes(snapshot.phase) ? '正在获取正文' :
      snapshot.phase === 'catalog-preview-ready' ? `目录 ${snapshot.catalogSummary?.count ?? 0} 章待核对` :
      snapshot.phase === 'catalog-not-ready' ? '尚未找到目录章节' :
      snapshot.phase === 'waiting-catalog' ? '正在打开目录' :
      snapshot.phase === 'receiving-catalog' ? `目录 ${snapshot.catalogSummary?.count}/${snapshot.catalogSummary?.total}` :
      snapshot.bookshelfSummary ? `书单 ${snapshot.bookshelfSummary.count} 本待核对` : snapshot.phase === 'probe-complete' ? '书架访问完成' :
      snapshot.lastSeenAt ? '浏览器已连接' : '等待浏览器';
    if (diagnosticPreviews && snapshot.phase === 'catalog-preview-ready' && !catalogShown) { catalogShown = true; showCatalog(); }
    if (snapshot.recovery.waitingLogin) chapterShown = false;
    if (snapshot.failure && snapshot.failure.sequence !== lastFailure) {
      lastFailure = snapshot.failure.sequence;
      if (snapshot.phase !== 'chapter-unavailable') {
        const message = snapshot.failure.reason === 'cancelled' ? '已取消当前任务。' : chapterFailureMessage[snapshot.failure.reason];
        if (snapshot.failure.reason === 'cancelled') void vscode.window.showInformationMessage(message);
        else if (diagnosticPreviews) void vscode.window.showWarningMessage(message);
        else if (snapshot.phase !== 'prefetch-failed') { readingFailure = 'foreground'; reader.failure(message); }
      }
    }
    if (['chapter-preview-ready', 'chapter-unavailable'].includes(snapshot.phase) && !chapterShown) {
      chapterShown = true; if (diagnosticPreviews) showChapter(); const result = probe.getChapter();
      if (result?.status === 'unavailable') {
        if (diagnosticPreviews) void vscode.window.showWarningMessage(chapterFailureMessage[result.reason]);
        else { readingFailure = 'foreground'; prefetch?.pause(); reader.failure(chapterFailureMessage[result.reason]); }
      }
    }
    if (diagnosticPreviews && snapshot.bookshelfSummary && !bookshelfShown && !/catalog|chapter/.test(snapshot.phase)) { bookshelfShown = true; showBookshelf(); }
    const guide = setup.view();
    status.text = guide.text ? `$(book) ${guide.text}` : '$(book)';
    status.tooltip = hoverMenu(guide.text || (refreshing ? '正在关闭旧页面并重新获取书架…' : display.replace(/待核对/g, '已就绪')), setup.active || refreshing || !!probe.currentTaskId(), guide,
      { shelf: !!probe.getBookshelf(), custom: customSite() });
    navigation?.update();
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
    // Generic idlepage/1 servers (practice etc.): requests run in the companion on the server's origin.
    const remoteChannel = new RemoteChannel();
    // Configured practice pages; the older single-address setting still counts until the list is saved.
    const siteUrls = (): string[] => {
      const config = vscode.workspace.getConfiguration('idlepage');
      const list = config.get<string[]>('remote.servers', []).filter(u => typeof u === 'string' && !!serverAddress(u));
      const legacy = config.get<string>('remote.server', '');
      return [...new Set(list.length || !serverAddress(legacy) ? list : [legacy.trim()])];
    };
    remoteChannel.wanted = siteUrls().length > 0;
    context.subscriptions.push({ dispose: () => remoteChannel.dispose() });
    bridge = new LocalBridgeServer({ port, token, origin, probe, onChanged: update, remote: remoteChannel,
      onContact: () => {
        browserSession?.noteContact();
        if (setup.contact()) {
          // Setup ends at the first companion contact; site logins happen lazily on first use.
          void context.globalState.update('idlepage.setupCompleted', true);
          manageVisibility = true; void visibility.requestHide(); update();
          setTimeout(() => { if (setup.stage === 'ready') { setup.dismiss(); update(); } }, 30000);
        }
      },
      onRejected: (reason, method) => {
        // Coarse diagnostic only: never record headers, credentials, bodies or account information.
        void writeFile(join(storage, 'bridge-diagnostics.json'), JSON.stringify({ reason, method, observedAt: new Date().toISOString() })).catch(() => {});
      },
    });
    await bridge.start();
    if (cacheEnabled) {
      try {
        const candidate = new ReadingCache(join(storage, 'reading-cache'), vscode.workspace.getConfiguration('idlepage').get<number>('cache.maxSizeMB', 200) * 1024 * 1024);
        await candidate.initialize();
        const shelf = await candidate.shelf();
        const catalog = shelf?.books[0] ? await candidate.catalog(shelf.books[0].id) : undefined;
        probe.restoreMetadata(shelf, catalog?.catalog); cache = candidate;
      } catch { warnCache(); }
    }
    prefetch = new ReadingPrefetch(probe, cache, update, () => ensureBrowser(), reason => {
      readingFailure = 'prefetch';
      const messages: Record<string, string> = { 'cache-disabled': '预取暂停：缓存未启用', 'cache-capacity': '预取暂停：缓存空间不足', 'cache-error': '预取暂停：缓存读写失败', 'needs-login': '预取暂停：需要登录', 'locked': '预取暂停：章节不可获取', 'access-blocked': '预取暂停：访问受阻', 'timeout': '预取暂停：读取超时', 'connection-failed': '预取暂停：浏览器未连接' };
      reader.failure(messages[reason] ?? '预取暂停：章节获取失败');
    });
    context.subscriptions.push({ dispose: () => prefetch?.dispose() });
    // Do not overwrite a running window's paired copy when binding fails.
    const remoteOrigins = () => [...new Set(siteUrls().map(u => serverAddress(u)!.origin))];
    const companion = await prepareCompanion(context.extensionPath, storage, bridge.endpoint(), token, remoteOrigins());
    setCompanionDirectory(companion.directory);
    browserSession = new BrowserSession({ isRunning: async () => {
      const result = await new EdgeWindowControl().control('inspect');
      if (['failed', 'ambiguous'].includes(result.status)) throw new Error('BrowserInspectionFailed');
      return result.status !== 'not-running';
    }, launch: async () => {
      await lifetime.launch(() => openDedicatedEdge());
      void visibility.requestHide();
    }, isCurrent: id => probe.isCurrentTask(id), hasObserved: id => probe.hasObservedTask(id), onChanged: update });
    context.subscriptions.push({ dispose: () => browserSession?.dispose() });
    stopBrowser = async () => { shuttingDown = true; selectionEpoch++; prefetch?.dispose(); visibility.dispose(); browserSession?.dispose(); try { await progress.flush(); await cache?.flush(); } finally { await lifetime.stop(); } };
    ensureBrowser = (force = false) => {
      const id = probe.currentTaskId();
      if (!id || probe.pendingCacheChapter() || refreshing || shuttingDown) return;
      const config = vscode.workspace.getConfiguration('idlepage');
      if (!force && !config.get<boolean>('browser.autoStart', true) && !config.get<boolean>('browser.autoHide', true)) return;
      void lifetime.start().then(async () => {
        if (refreshing || shuttingDown || !probe.isCurrentTask(id)) return;
        manageVisibility = true; void visibility.requestHide();
        if (!force && !config.get<boolean>('browser.autoStart', true)) return;
        const result = await browserSession!.ensure(id);
        if (['launch-failed', 'connection-timeout'].includes(result) && probe.failConnection(id)) update();
      }).catch(() => { if (probe.failConnection(id)) { output.appendLine('无法接管专用浏览器的生命周期，请检查其他 IdlePage 服务窗口。'); update(); } });
    };
    // One client per configured URL, kept while the URL stays in the list (it caches the site's descriptor).
    const remoteClients = new Map<string, RemoteClient>();
    const study = new StudyController({
      sites: () => {
        const urls = siteUrls();
        for (const url of [...remoteClients.keys()]) if (!urls.includes(url)) remoteClients.delete(url);
        return urls.map(url => {
          let client = remoteClients.get(url);
          if (!client) remoteClients.set(url, client = new RemoteClient((job, timeout) =>
            // Fail fast while the companion is not polling; the controller then starts the browser.
            remoteChannel.connected() ? remoteChannel.run(job, timeout) : Promise.resolve({ error: 'NotPickedUp' }), serverAddress(url)!));
          return { url, client };
        });
      },
      saveSites: async urls => {
        const config = vscode.workspace.getConfiguration('idlepage');
        try {
          await config.update('remote.servers', urls, vscode.ConfigurationTarget.Global);
        } catch (error) {
          // After installing an update without reloading the window, VS Code may still hold the previous
          // manifest's settings list and refuse a newly added setting as "not a registered configuration".
          const stale = /not a registered configuration/i.test(String((error as Error)?.message ?? error));
          const message = stale ? '余页：插件刚更新，需要重新加载 VS Code 窗口后才能保存练习网址。' : `余页：练习网址未能保存（${String((error as Error)?.message ?? error).slice(0, 120)}）`;
          void vscode.window.showErrorMessage(message, ...(stale ? ['重新加载窗口'] : [])).then(choice => {
            if (choice === '重新加载窗口') void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
          return false;
        }
        // The list replaces the older single-address setting.
        if (config.inspect<string>('remote.server')?.globalValue !== undefined) await config.update('remote.server', undefined, vscode.ConfigurationTarget.Global);
        return true;
      },
      ensureBrowser: async () => {
        if (refreshing || shuttingDown) return false;
        try {
          await lifetime.start();
          if ((await new EdgeWindowControl().control('inspect')).status === 'not-running') {
            await lifetime.launch(() => openDedicatedEdge());
            manageVisibility = true; void visibility.requestHide();
          }
          // A worker that just reloaded for a new server permission needs a few seconds.
          for (let i = 0; i < 90 && !remoteChannel.connected() && !shuttingDown; i++) await new Promise(resolve => setTimeout(resolve, 500));
          return remoteChannel.connected();
        } catch { return false; }
      },
      revealBrowser: async () => { const result = await browserWindows.revealForAttention(); if (result.status !== 'ok') throw new Error('RevealFailed'); },
      hideBrowser: () => { manageVisibility = true; void visibility.requestHide(); },
      changed: () => update(),
    });
    customSite = () => study.state();
    context.subscriptions.push(study, vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('idlepage.remote.servers') && !event.affectsConfiguration('idlepage.remote.server')) return;
      remoteChannel.wanted = siteUrls().length > 0; study.serverChanged();
      // Re-pair so the companion gains host permission for new servers and reloads itself.
      void prepareCompanion(context.extensionPath, storage, bridge!.endpoint(), token!, remoteOrigins())
        .catch(() => { void vscode.window.showWarningMessage('余页：无法更新浏览器扩展的服务器权限。'); });
    }));
    const refreshBookshelf = () => {
      if (setup.active || refreshing || shuttingDown) return false;
      selectionEpoch++; prefetch?.pause(); diagnosticPreviews = false; probe.startBookshelfExtraction(); update(); ensureBrowser(); return true;
    };
    const resumeReading = async (bookmark = progress.last()) => {
      if (setup.active || refreshing || shuttingDown) return;
      if (!bookmark) { void vscode.window.showInformationMessage('尚无本地阅读进度，请先从书架选择章节。'); return; }
      if (pendingResume?.epoch === selectionEpoch && probe.currentTaskId()) return;
      const epoch = ++selectionEpoch; prefetch?.pause(); diagnosticPreviews = false; probe.invalidateTask(); probe.setReadingMode(true);
      pendingResume = { bookmark, epoch, requested: false };
      const cached = await cache?.catalog(bookmark.bookId).catch(() => { warnCache(); return undefined; });
      if (epoch !== selectionEpoch || shuttingDown || refreshing) return;
      probe.resumeBook(bookmark.bookId, cached?.catalog); update(); ensureBrowser();
    };
    navigation = new Navigation(probe, {
      bookmark: id => progress.get(id),
      resume: bookmark => { void resumeReading(bookmark); },
      shelf: refreshBookshelf,
      book: async (id, refresh) => {
        if (refreshing) return;
        const epoch = ++selectionEpoch; prefetch?.pause(); diagnosticPreviews = false; probe.invalidateTask();
        const cached = !refresh ? await cache?.catalog(id).catch(() => { warnCache(); return undefined; }) : undefined;
        if (epoch !== selectionEpoch || shuttingDown || refreshing) return;
        if (probe.selectBook(id, cached?.catalog)) { update(); ensureBrowser(); }
      },
      chapter: (book, chapter) => {
        if (refreshing) return; selectionEpoch++; prefetch?.pause(); probe.setReadingMode(true); diagnosticPreviews = false;
        if (probe.selectChapter(book, chapter)) { reader.returnReading(); chapterShown = false; update(); ensureBrowser(); }
      },
    });
    context.subscriptions.push(navigation);
    update();
    output.appendLine(`本机服务：${bridge.endpoint()}`);
    output.appendLine(`浏览器辅助扩展目录：${companion.directory}`);
    const controlBrowserWindow = async (action: 'show' | 'hide') => {
      if (refreshing) return 'busy';
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
    const refreshAll = async () => {
      if (setup.active || refreshing || shuttingDown) return false;
      const epoch = ++selectionEpoch; prefetch?.pause(); refreshing = true; diagnosticPreviews = false; probe.invalidateTask(); update();
      try {
        await lifetime.start();
        try { await lifetime.stop(); } finally { if (!shuttingDown) lifetime = new EdgeLifetime(storage); }
        if ((await new EdgeWindowControl().control('inspect')).status !== 'not-running') throw new Error('BrowserStillRunning');
        if (shuttingDown) return false;
        browserSession?.forgetContact();
        if (epoch !== selectionEpoch || shuttingDown) return false;
        probe.startBookshelfExtraction(); refreshing = false; update(); navigation!.openShelf(); ensureBrowser(true); return true;
      } catch { void vscode.window.showWarningMessage('全部刷新未完成，已停止操作。可通过显示辅助浏览器排查后重试。'); return false; }
      finally { refreshing = false; update(); }
    };
    const action = (name: string, fn: () => unknown) => vscode.commands.registerCommand(name, () => {
      if (setup.active || refreshing || shuttingDown) return 'busy';
      selectionEpoch++; prefetch?.pause(); probe.setReadingMode(false); diagnosticPreviews = true; return fn();
    });
    context.subscriptions.push(
      vscode.commands.registerCommand('idlepage.nextSegment', () => { if (!reader.state().hidden && !reader.state().error && !reader.next()) return vscode.commands.executeCommand('idlepage.nextChapter'); }),
      vscode.commands.registerCommand('idlepage.previousSegment', () => { if (!reader.state().hidden && !reader.state().error) reader.previous(); }),
      vscode.commands.registerCommand('idlepage.toggleReading', () => reader.state().count ? reader.toggle() : resumeReading()),
      vscode.commands.registerCommand('idlepage.returnReading', async () => {
        if (!reader.state().count) return resumeReading();
        reader.returnReading();
        if (browserWindows.mode === 'diagnostic') {
          try { const result = await browserWindows.hide(); if (result.status !== 'ok') reader.failure('浏览器未能隐藏'); }
          catch { reader.failure('浏览器未能隐藏'); }
        }
      }),
      vscode.commands.registerCommand('idlepage.retryReading', () => {
        if (refreshing || shuttingDown) return;
        reader.returnReading();
        if (readingFailure === 'prefetch') prefetch?.retry();
        else { prefetch?.pause(); chapterShown = false; if (probe.retryReadingChapter()) { update(); ensureBrowser(); } }
      }),
      vscode.commands.registerCommand('idlepage.openBookshelf', () => {
        if (refreshing || setup.active) return;
        if (setup.stage === 'offer' && !probe.getBookshelf()) return vscode.commands.executeCommand('idlepage.prepareBrowser');
        setup.dismiss(); update(); navigation!.openShelf();
      }),
      vscode.commands.registerCommand('idlepage.refreshBookshelf', () => { if (refreshBookshelf()) navigation!.openShelf(); }),
      vscode.commands.registerCommand('idlepage.refreshAll', refreshAll),
      vscode.commands.registerCommand('idlepage.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:myosotis0v0.idle-page')),
      // Rebound shortcuts have User source, so @ext would hide them after editing.
      vscode.commands.registerCommand('idlepage.openKeybindings', () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'idlepage')),
      vscode.commands.registerCommand('idlepage.cancelTask', () => { const settingUp = setup.active; setup.dismiss(); selectionEpoch++; const wasPrefetch = probe.isPrefetching(); prefetch?.pause(); const cancelled = probe.cancel() || wasPrefetch; update(); if (diagnosticPreviews && probe.getReadingChapter()) showChapter(); return settingUp || cancelled || refreshing; }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('idlepage.reading.widthPercent') || event.affectsConfiguration('idlepage.reading.leftOffsetPercent') || event.affectsConfiguration('window.zoomLevel')) reader.render();
        if (cache && event.affectsConfiguration('idlepage.cache.maxSizeMB')) void cache.setLimit(vscode.workspace.getConfiguration('idlepage').get<number>('cache.maxSizeMB', 200) * 1024 * 1024).catch(warnCache);
      }),
      vscode.commands.registerCommand('idlepage.showBrowser', () => controlBrowserWindow('show')),
      vscode.commands.registerCommand('idlepage.hideBrowser', () => controlBrowserWindow('hide')),
      vscode.commands.registerCommand('idlepage.showStatus', () => {
        output.appendLine(JSON.stringify(probe.snapshot(), null, 2)); output.show(true);
      }),
      vscode.commands.registerCommand('idlepage.copyBrowserDirectory', () => vscode.env.clipboard.writeText(companion.directory)),
      vscode.commands.registerCommand('idlepage.openBrowserExtensions', async () => {
        if (refreshing || shuttingDown) return;
        try { await lifetime.launch(openEdgeExtensions); await browserWindows.revealForAttention(); }
        catch { setup.fail('无法打开 Edge，请确认已安装 Microsoft Edge 后重新设置'); update(); }
      }),
      vscode.commands.registerCommand('idlepage.prepareBrowser', async () => {
        if (refreshing || shuttingDown || !setup.start()) return;
        const epoch = ++selectionEpoch;
        prefetch?.pause(); navigation?.dispose(); probe.invalidateTask(); probe.setReadingMode(false);
        diagnosticPreviews = false; manageVisibility = false; update();
        try {
          // The dedicated Edge loads the paired companion itself (--load-extension); nothing to install by hand.
          // Restart a running one so it comes up with the current launch switches and extension.
          await lifetime.start();
          if ((await new EdgeWindowControl().control('inspect')).status !== 'not-running') {
            try { await lifetime.stop(); } finally { if (!shuttingDown) lifetime = new EdgeLifetime(storage); }
            browserSession?.forgetContact();
          }
          if (epoch !== selectionEpoch || shuttingDown || !setup.active) return;
          setup.opened(); update();
          await lifetime.launch(() => openDedicatedEdge());
          manageVisibility = true; void visibility.requestHide();
        } catch { if (epoch === selectionEpoch && setup.active) { setup.fail('准备失败，请确认 Edge 已安装后重新设置'); update(); } }
      }),
      action('idlepage.restartProbe', () => { probe.restart(); update(); ensureBrowser(); }),
      action('idlepage.extractBookshelf', () => { bookshelfShown = false; probe.startBookshelfExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showBookshelf', showBookshelf),
      action('idlepage.extractCatalog', () => { catalogShown = false; probe.startCatalogExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showCatalog', showCatalog),
      action('idlepage.extractChapter', () => { chapterShown = false; probe.startChapterExtraction(); update(); ensureBrowser(); }),
      vscode.commands.registerCommand('idlepage.showChapter', showChapter),
      vscode.commands.registerCommand('idlepage.nextChapter', () => {
        if (setup.active || refreshing || shuttingDown) return 'busy'; selectionEpoch++; prefetch?.pause();
        probe.setReadingMode(!diagnosticPreviews);
        const result = probe.startNextChapter();
        if (result !== 'started') {
          void vscode.window.showInformationMessage({ busy: '正在获取章节，请稍候。', 'not-ready': '请先获取当前章正文。', end: '本次目录没有下一章。' }[result]); return result;
        }
        chapterShown = false; if (diagnosticPreviews) showChapter(); update(); ensureBrowser(); return result;
      }),
    );
    const expiryTimer = setInterval(() => {
      if (setup.expire()) { selectionEpoch++; probe.invalidateTask(); update(); }
      else if (probe.expireChapter()) update();
    }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(expiryTimer) });
    return { getBridgeStatus: () => ({ endpoint: bridge!.endpoint(), ...probe.snapshot() }), getCompanionDirectory: () => companion.directory,
      getBrowserWindowMode: () => browserWindows.mode, getCacheStatus: () => cache?.summary(),
      getReaderStatus: () => ({ ...reader.state(), text: undefined, chunks: undefined }),
      getEntryStatus: () => ({ text: status.text, hasClick: !!status.command, tooltip: (status.tooltip as vscode.MarkdownString)?.value }),
      getStudyRow: () => study.row() };
  } catch (error) {
    await bridge?.close(); bridge = undefined;
    const code = (error as NodeJS.ErrnoException).code;
    status.text = '$(book)'; status.tooltip = '余页：连接服务未启动，请检查 IdlePage 输出。';
    output.appendLine(code === 'EADDRINUSE' ? '本机端口已占用。当前原型只支持一个活动服务窗口。' : '本机服务启动失败。');
    throw new Error(code === 'EADDRINUSE' ? 'IdlePagePortInUse' : 'IdlePageBridgeStartupFailed');
  }
}
export async function deactivate(): Promise<void> {
  const cleanup = stopBrowser; stopBrowser = undefined;
  try { await bridge?.close(); }
  finally { bridge = undefined; await cleanup?.(); }
}
