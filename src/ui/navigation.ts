import * as vscode from 'vscode';
import type { QidianAccessProbe } from '../application/QidianAccessProbe';
import type { Bookmark } from '../application/ReadingProgress';

import type { CustomSiteState } from './Study';

export const menuCommands = ['idlepage.openBookshelf', 'idlepage.study.open', 'idlepage.study.setServer', 'idlepage.study.addSite', 'idlepage.study.removeSite', 'idlepage.study.login', 'idlepage.study.logout', 'idlepage.showBrowser', 'idlepage.hideBrowser', 'idlepage.refreshBookshelf', 'idlepage.refreshAll', 'idlepage.cancelTask', 'idlepage.openSettings', 'idlepage.toggleReading', 'idlepage.retryReading', 'idlepage.selectReadingLocation', 'idlepage.openKeybindings', 'idlepage.prepareBrowser', 'idlepage.copyBrowserDirectory', 'idlepage.openBrowserExtensions'];
const md = (value: string) => value.replace(/[\\`*_{}[\]()#+!|<>~-]/g, ch => '\\' + ch);
/**
 * Hover menu: shared browser connection, then the reading area and the custom-site (idlepage/1) area.
 * Logins are lazy, so each area offers only its login entry until that site is known to be signed in:
 * reading after a Qidian bookshelf exists, the custom site after a request proved its session.
 */
export function hoverMenu(message: string, busy: boolean, setup?: { text: string; detail: string; active: boolean },
  areas: { shelf: boolean; custom?: CustomSiteState } = { shelf: false }): vscode.MarkdownString {
  const menu = new vscode.MarkdownString('', true);
  menu.appendMarkdown('**余页**\n\n'); menu.appendText(message);
  if (setup?.text) { menu.appendMarkdown('\n\n'); menu.appendText(setup.detail); }
  menu.appendMarkdown('\n\n[$(plug) 首次连接设置 / 重新设置](command:idlepage.prepareBrowser)\n\n');
  menu.appendMarkdown('[$(eye) 显示专用浏览器](command:idlepage.showBrowser)　[$(eye-closed) 隐藏](command:idlepage.hideBrowser)\n\n');
  if (busy) menu.appendMarkdown('[$(close) 取消当前任务](command:idlepage.cancelTask)\n\n');
  menu.appendMarkdown('---\n\n**阅读**\n\n');
  if (!areas.shelf) menu.appendMarkdown('[$(account) 登录起点](command:idlepage.openBookshelf)\n\n');
  else {
    menu.appendMarkdown('[$(library) 进入书架](command:idlepage.openBookshelf)　[$(refresh) 刷新书架](command:idlepage.refreshBookshelf)　[$(refresh) 全部刷新](command:idlepage.refreshAll)\n\n');
    menu.appendMarkdown('[隐藏/恢复阅读](command:idlepage.toggleReading)　[重试预取](command:idlepage.retryReading)　[$(layout) 文本显示位置](command:idlepage.selectReadingLocation)\n\n');
  }
  menu.appendMarkdown('---\n\n**自定义网站**\n\n');
  // One row per configured practice page: its address, then its actions. Until a request proved the
  // site's session (lazy), the row offers only login; afterwards the account, practice and logout.
  const arg = (url: string) => encodeURIComponent(JSON.stringify([url]));
  // Rows stay on one line: a short name (full URL in its tooltip; clicking it does the row's main action)
  // and a clipped account name.
  const title = (text: string) => text.replace(/["\\]/g, '');
  for (const site of areas.custom?.sites ?? []) {
    const main = site.account ? 'open' : 'login';
    const name = `[${site.active ? '$(play)' : '$(link)'} ${md(site.label)}](command:idlepage.study.${main}?${arg(site.url)} "${title(site.url)}")`;
    const actions = site.account
      ? [`$(account) ${md(site.account.length > 10 ? site.account.slice(0, 9) + '…' : site.account)}`, `[$(mortar-board) ${site.active ? '换一组' : '练习'}](command:idlepage.study.open?${arg(site.url)})`, `[$(sign-out) 登出](command:idlepage.study.logout?${arg(site.url)})`]
      : [`[$(account) 登录](command:idlepage.study.login?${arg(site.url)})`];
    actions.push(`[$(edit)](command:idlepage.study.setServer?${arg(site.url)} "修改网址")`, `[$(trash)](command:idlepage.study.removeSite?${arg(site.url)} "删除")`);
    menu.appendMarkdown(`${name}　${actions.join('　')}\n\n`);
  }
  menu.appendMarkdown('[$(add) 添加网址](command:idlepage.study.addSite)\n\n');
  menu.appendMarkdown('---\n\n[$(keyboard) 配置快捷键](command:idlepage.openKeybindings)　[$(settings-gear) 设置](command:idlepage.openSettings)');
  menu.isTrusted = { enabledCommands: menuCommands }; return menu;
}
interface Item extends vscode.QuickPickItem { bookId?: string; chapterId?: string; resume?: boolean }
/** One disposable picker: all navigation stays inside VS Code's native UI. */
export class Navigation {
  private picker?: vscode.QuickPick<Item>;
  private bookId?: string;
  private loading = false;
  private rendered = '';
  private refresh = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: '刷新当前列表' };
  constructor(private readonly probe: QidianAccessProbe, private readonly actions: {
    shelf(): void; book(id: string, refresh: boolean): Promise<void>; chapter(book: string, chapter: string): void;
    bookmark?(book: string): Bookmark | undefined; resume?(bookmark: Bookmark): void;
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
        if (item.chapterId && item.bookId) {
          const bookmark = item.resume ? this.actions.bookmark?.(item.bookId) : undefined;
          if (bookmark) this.actions.resume?.(bookmark); else this.actions.chapter(item.bookId, item.chapterId);
          picker.hide();
        }
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
      const bookmark = this.actions.bookmark?.(this.bookId);
      if (bookmark) items.push({ label: `$(history) 继续阅读 · ${bookmark.title}`, description: `上次读到 ${bookmark.progress}%`, bookId: bookmark.bookId, chapterId: bookmark.chapterId, resume: true, alwaysShow: true });
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
