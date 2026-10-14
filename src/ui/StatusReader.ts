import * as vscode from 'vscode';
import { ReadingText } from '../application/ReadingText';
import { WindowWidth } from '../infrastructure/WindowWidth';
import { statusPlacement } from './statusPlacement';

export class StatusReader implements vscode.Disposable {
  private changed = new vscode.EventEmitter<ReturnType<StatusReader['state']>>();
  readonly onDidChange = this.changed.event;
  private number = vscode.window.createStatusBarItem('idlepage.chapterNumber.left', vscode.StatusBarAlignment.Left, -1);
  private bodies = [0, 1, 2].map(i => vscode.window.createStatusBarItem('idlepage.readingText' + i + '.left', vscode.StatusBarAlignment.Left, -2 - i));
  private progress = vscode.window.createStatusBarItem('idlepage.chapterProgress.left', vscode.StatusBarAlignment.Left, -5);
  private back = vscode.window.createStatusBarItem('idlepage.returnReading.left', vscode.StatusBarAlignment.Left, -6);
  private spacers: vscode.StatusBarItem[] = [];
  private rightAligned = false;
  private layout = new ReadingText();
  private width = 1000;
  private count = '';
  private hidden = false;
  private error?: string;
  private widthTimer?: ReturnType<typeof setTimeout>;
  private geometry = new WindowWidth(width => {
    if (!vscode.window.state.focused || this.width === width) return;
    if (this.widthTimer) clearTimeout(this.widthTimer);
    if (width < this.width) { this.width = width; this.render(); }
    else if (width - this.width >= 26) this.widthTimer = setTimeout(() => {
      if (vscode.window.state.focused) { this.width = width; this.render(); }
    }, 300);
  });
  constructor() {
    this.configureItems();
  }
  private configureItems() {
    this.number.name = '余页章节'; this.bodies[0].name = '余页正文'; this.progress.name = '余页进度'; this.back.name = '余页返回阅读';
    this.bodies.forEach(item => { item.command = 'idlepage.nextSegment'; }); this.back.command = 'idlepage.returnReading'; this.back.text = '$(arrow-left) 返回阅读';
    this.number.command = 'idlepage.openBookshelf';
  }
  private place(right: boolean, chunks: string[]) {
    if (right !== this.rightAligned) {
      for (const item of [this.number, ...this.bodies, this.progress, this.back, ...this.spacers]) item.dispose();
      this.spacers = [];
      this.rightAligned = right;
      const alignment = right ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
      const base = right ? 10000 : 0;
      const side = right ? '.right' : '.left';
      // VS Code restores alignment by ID. An ID must always belong to one side.
      this.number = vscode.window.createStatusBarItem('idlepage.chapterNumber' + side, alignment, base - 1);
      this.bodies = [0, 1, 2].map(i => vscode.window.createStatusBarItem('idlepage.readingText' + i + side, alignment, base - 2 - i));
      this.progress = vscode.window.createStatusBarItem('idlepage.chapterProgress' + side, alignment, base - 5);
      this.back = vscode.window.createStatusBarItem('idlepage.returnReading' + side, alignment, base - 6);
      this.configureItems();
    }
    while (this.spacers.length < chunks.length) {
      const i = this.spacers.length;
      const item = vscode.window.createStatusBarItem('idlepage.readingOffset' + i + (right ? '.right' : '.left'),
        right ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
        right ? 9993 - i : -0.5 - i * 0.1);
      item.name = '余页阅读偏移';
      this.spacers.push(item);
    }
    this.spacers.forEach((item, i) => {
      if (i < chunks.length) { item.text = chunks[i]; item.show(); } else item.hide();
    });
  }
  set(identity: string, text: string, current: number, total: number, offset = 0, reveal = false) {
    this.count = `${current}/${total}`; this.layout.set(identity, text); this.layout.seek(offset);
    if (reveal) this.hidden = false;
    this.geometry.start(); this.render();
  }
  failure(message: string) { this.error = message; this.render(); }
  returnReading(reveal = true) { this.error = undefined; if (reveal) this.hidden = false; this.render(); }
  toggle() { this.hidden = !this.hidden; this.render(); }
  next() { const moved = this.layout.next(); this.render(); return moved; }
  previous() { this.layout.previous(); this.render(); }
  state() { return { ...this.layout.view(), count: this.count, error: this.error, hidden: this.hidden, alignment: this.number.alignment }; }
  render() {
    void vscode.commands.executeCommand('setContext', 'idlepage.readingHidden', this.hidden);
    const percentage = vscode.workspace.getConfiguration('idlepage').get<number>('reading.widthPercent', 60);
    const zoom = vscode.workspace.getConfiguration('window').get<number>('zoomLevel', 0);
    const logicalWidth = this.width / Math.pow(1.2, zoom);
    const offset = vscode.workspace.getConfiguration('idlepage').get<number>('reading.leftOffsetPercent', 0);
    // VS Code caps each native item at 40vw. Use <=30% chunks with room for
    // the native item's margins/padding; preserve one logical reading segment.
    const slots = Math.max(1, Math.ceil(percentage / 30));
    const perItemCells = Math.max(4, Math.floor((logicalWidth * percentage / 100 / slots - 24) / 13));
    this.layout.resize(perItemCells, slots);
    this.changed.fire(this.state());
    const external = vscode.workspace.getConfiguration('idlepage').get<string>('reading.location', 'statusBar') !== 'statusBar';
    if (this.hidden || !this.count && !this.error || external && !this.error) { for (const item of [this.number, ...this.bodies, this.progress, this.back, ...this.spacers]) item.hide(); return; }
    const placement = statusPlacement(logicalWidth, percentage, offset);
    this.place(placement.right, this.error ? [] : placement.chunks);
    const view = this.layout.view();
    this.number.text = this.count || '0/0'; this.number.show();
    const tooltip = new vscode.MarkdownString();
    if (this.error) { tooltip.appendText(this.error); tooltip.appendMarkdown('\n\n'); }
    tooltip.appendMarkdown(this.error
      ? '[显示浏览器检查](command:idlepage.showBrowser) · [返回阅读](command:idlepage.returnReading) · [重试](command:idlepage.retryReading)'
      : '[上一段](command:idlepage.previousSegment) · [下一段](command:idlepage.nextSegment) · [下一章](command:idlepage.nextChapter) · [隐藏阅读](command:idlepage.toggleReading)\n\n[配置快捷键](command:idlepage.openKeybindings)');
    tooltip.isTrusted = { enabledCommands: ['idlepage.showBrowser', 'idlepage.returnReading', 'idlepage.retryReading', 'idlepage.previousSegment', 'idlepage.nextSegment', 'idlepage.nextChapter', 'idlepage.toggleReading', 'idlepage.openKeybindings'] };
    const chunks = this.error ? [this.error] : view.chunks;
    // Partition by the same measured units used for pagination, never truncate.
    while (this.bodies.length < chunks.length) this.bodies.push(vscode.window.createStatusBarItem('idlepage.readingText' + this.bodies.length + (this.rightAligned ? '.right' : '.left'), this.rightAligned ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left, (this.rightAligned ? 10000 : 0) - 2 - this.bodies.length));
    this.bodies.forEach((item, index) => {
      item.name = 'IdlePage reading';
      if (index >= chunks.length) { item.hide(); return; }
      item.text = this.error ? '$(warning) 读取失败 · 显示浏览器检查' : chunks[index];
      item.command = this.error ? 'idlepage.showBrowser' : 'idlepage.nextSegment';
      item.backgroundColor = this.error ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      item.tooltip = tooltip; item.show();
    });
    this.progress.text = `${view.progress}%`; this.progress.show();
    if (this.error) this.back.show(); else this.back.hide();
  }
  dispose() { if (this.widthTimer) clearTimeout(this.widthTimer); this.changed.dispose(); this.geometry.dispose(); for (const item of [this.number, ...this.bodies, this.progress, this.back, ...this.spacers]) item.dispose(); }
}
