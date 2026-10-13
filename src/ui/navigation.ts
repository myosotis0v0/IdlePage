import * as vscode from 'vscode';
import type { QidianAccessProbe } from '../application/QidianAccessProbe';

export const menuCommands = ['idlepage.openBookshelf', 'idlepage.showBrowser', 'idlepage.hideBrowser', 'idlepage.refreshBookshelf', 'idlepage.refreshAll', 'idlepage.cancelTask', 'idlepage.openSettings', 'idlepage.toggleReading', 'idlepage.retryReading', 'idlepage.selectReadingLocation', 'idlepage.openKeybindings', 'idlepage.prepareBrowser', 'idlepage.copyBrowserDirectory', 'idlepage.openBrowserExtensions'];
export function hoverMenu(message: string, busy: boolean, setup?: { text: string; detail: string; active: boolean }): vscode.MarkdownString {
  const menu = new vscode.MarkdownString('', true);
  menu.appendMarkdown('**余页**\n\n'); menu.appendText(message);
  if (setup?.text) { menu.appendMarkdown('\n\n'); menu.appendText(setup.detail); }
  menu.appendMarkdown('\n\n[$(plug) 首次连接设置 / 重新设置](command:idlepage.prepareBrowser)\n\n');
  if (setup?.text) menu.appendMarkdown('[复制扩展目录](command:idlepage.copyBrowserDirectory) · [打开 Edge 扩展页](command:idlepage.openBrowserExtensions)\n\n');
  menu.appendMarkdown('\n\n---\n\n[$(library) 进入书架](command:idlepage.openBookshelf)\n\n[$(eye) 显示专用浏览器](command:idlepage.showBrowser)　[$(eye-closed) 隐藏](command:idlepage.hideBrowser)\n\n[$(refresh) 刷新书架](command:idlepage.refreshBookshelf)\n\n[$(refresh) 全部刷新](command:idlepage.refreshAll)\n\n');
  if (busy) menu.appendMarkdown('[$(close) 取消当前任务](command:idlepage.cancelTask)\n\n');
  menu.appendMarkdown('[隐藏/恢复阅读](command:idlepage.toggleReading)　[重试预取](command:idlepage.retryReading)\n\n');
  menu.appendMarkdown('[$(layout) 文本显示位置](command:idlepage.selectReadingLocation)\n\n');
  menu.appendMarkdown('[$(keyboard) 配置快捷键](command:idlepage.openKeybindings)\n\n');
  menu.appendMarkdown('[$(settings-gear) 设置](command:idlepage.openSettings)');
  menu.isTrusted = { enabledCommands: menuCommands }; return menu;
}
interface Item extends vscode.QuickPickItem { bookId?: string; chapterId?: string }
/** One disposable picker: all navigation stays inside VS Code's native UI. */
export class Navigation {
  private picker?: vscode.QuickPick<Item>;
  private bookId?: string;
  private loading = false;
  private rendered = '';
  private refresh = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: '刷新当前列表' };
  constructor(private readonly probe: QidianAccessProbe, private readonly actions: {
    shelf(): void; book(id: string, refresh: boolean): Promise<void>; chapter(book: string, chapter: string): void;
  }) {}
  openShelf() {
    this.bookId = undefined; this.loading = false; this.rendered = '';
    if (this.picker) this.picker.value = '';
    if (!this.picker) {
      const picker = vscode.window.createQuickPick<Item>(); this.picker = picker;
      picker.matchOnDescription = true; picker.matchOnDetail = true;
      picker.onDidHide(() => { if (this.picker === picker) this.picker = undefined; picker.dispose(); });
      picker.onDidTriggerButton(button => {
        if (button === vscode.QuickInputButtons.Back) { this.openShelf(); return; }
        if (this.bookId) void this.loadBook(this.bookId, true); else this.actions.shelf();
      });
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0]; if (!item) return;
        if (item.chapterId && item.bookId) { this.actions.chapter(item.bookId, item.chapterId); picker.hide(); }
        else if (item.bookId) void this.loadBook(item.bookId, false);
      });
    }
    if (!this.probe.getBookshelf() && !['waiting-bookshelf-list', 'waiting-login'].includes(this.probe.snapshot().phase)) this.actions.shelf();
    this.update(); this.picker.show();
  }
  private async loadBook(id: string, refresh: boolean) {
    this.bookId = id; this.loading = true; this.rendered = ''; this.picker!.value = ''; this.update();
    try { await this.actions.book(id, refresh); }
    finally { if (this.bookId === id) { this.loading = false; this.update(); } }
  }
  update() {
    const picker = this.picker; if (!picker) return;
    const state = this.probe.snapshot(), shelf = this.probe.getBookshelf(), catalog = this.probe.getCatalog();
    const reading = this.probe.readingLocation();
    const pending = this.loading || !!this.probe.currentTaskId() && !state.background;
    picker.busy = pending;
    picker.title = this.bookId ? `目录 · ${shelf?.books.find(b => b.id === this.bookId)?.title ?? '加载中'}` : '余页 · 书架';
    picker.buttons = this.bookId ? [vscode.QuickInputButtons.Back, this.refresh] : [this.refresh];
    picker.placeholder = state.recovery.waitingLogin ? '请在专用浏览器完成登录，随后自动继续' : pending ? '正在加载… 可按 Esc 收起，或在书本菜单取消任务' : this.bookId ? '搜索章节名、序号或卷名' : '搜索书名';
    const items: Item[] = [];
    if (!this.bookId) {
      for (const book of shelf?.books ?? []) items.push({ label: book.title, description: reading.bookId === book.id ? '正在阅读' : undefined, bookId: book.id });
    } else if (!this.loading && catalog?.bookId === this.bookId && catalog.chapters.length === catalog.total) {
      let volume: string | undefined;
      catalog.chapters.forEach((chapter, index) => {
        if (chapter.volume && volume !== chapter.volume) { items.push({ label: chapter.volume, kind: vscode.QuickPickItemKind.Separator }); volume = chapter.volume; }
        items.push({ label: chapter.title, description: `${index + 1}${reading.bookId === catalog.bookId && reading.chapterId === chapter.id ? ' · 当前章节' : ''}`, detail: chapter.volume || undefined, bookId: catalog.bookId, chapterId: chapter.id });
      });
    }
    if (!items.length && !pending) picker.placeholder = state.failure ? '获取未完成，可点击刷新重试或返回书架' : this.bookId ? '尚无可用章节，点击刷新重试' : '当前书架页为空，点击刷新获取最新书单';
    const signature = JSON.stringify(items);
    if (signature !== this.rendered) { this.rendered = signature; picker.items = items; }
  }
  dispose() { this.picker?.hide(); }
}
