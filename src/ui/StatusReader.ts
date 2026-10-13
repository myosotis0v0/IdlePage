import * as vscode from 'vscode';
import { ReadingText, splitStatusText } from '../application/ReadingText';
import { WindowWidth } from '../infrastructure/WindowWidth';

export class StatusReader implements vscode.Disposable {
  private changed = new vscode.EventEmitter<ReturnType<StatusReader['state']>>();
  readonly onDidChange = this.changed.event;
  private number = vscode.window.createStatusBarItem('idlepage.chapterNumber', vscode.StatusBarAlignment.Left, -1);
  private bodies = [0, 1, 2].map(i => vscode.window.createStatusBarItem('idlepage.readingText' + i, vscode.StatusBarAlignment.Left, -2 - i));
  private progress = vscode.window.createStatusBarItem('idlepage.chapterProgress', vscode.StatusBarAlignment.Left, -5);
  private back = vscode.window.createStatusBarItem('idlepage.returnReading', vscode.StatusBarAlignment.Left, -6);
  private layout = new ReadingText();
  private width = 1000;
  private count = '';
  private hidden = false;
  private error?: string;
  private geometry = new WindowWidth(width => { if (vscode.window.state.focused && this.width !== width) { this.width = width; this.render(); } });
  constructor() {
    this.number.name = '余页章节'; this.bodies[0].name = '余页正文'; this.progress.name = '余页进度'; this.back.name = '余页返回阅读';
    this.bodies.forEach(item => { item.command = 'idlepage.nextSegment'; }); this.back.command = 'idlepage.returnReading'; this.back.text = '$(arrow-left) 返回阅读';
    this.number.command = 'idlepage.openBookshelf';
  }
  set(identity: string, text: string, current: number, total: number) {
    this.count = `${current}/${total}`; this.layout.set(identity, text); this.geometry.start(); this.render();
  }
  failure(message: string) { this.error = message; this.hidden = false; this.render(); }
  returnReading() { this.error = undefined; this.hidden = false; this.render(); }
  toggle() { this.hidden = !this.hidden; this.render(); }
  next() { const moved = this.layout.next(); this.render(); return moved; }
  previous() { this.layout.previous(); this.render(); }
  state() { return { ...this.layout.view(), count: this.count, error: this.error, hidden: this.hidden }; }
  render() {
    const percentage = vscode.workspace.getConfiguration('idlepage').get<number>('reading.widthPercent', 60);
    const zoom = vscode.workspace.getConfiguration('window').get<number>('zoomLevel', 0);
    const logicalWidth = this.width / Math.pow(1.2, zoom);
    // VS Code caps each native item at 40vw. Use <=30% chunks with room for
    // the native item's margins/padding; preserve one logical reading segment.
    const slots = Math.max(1, Math.ceil(percentage / 30));
    const perItemCells = Math.max(4, Math.floor((logicalWidth * percentage / 100 / slots - 24) / 13));
    this.layout.resize(perItemCells * slots - (slots - 1));
    this.changed.fire(this.state());
    const external = vscode.workspace.getConfiguration('idlepage').get<string>('reading.location', 'statusBar') !== 'statusBar';
    if (this.hidden || !this.count && !this.error || external && !this.error) { for (const item of [this.number, ...this.bodies, this.progress, this.back]) item.hide(); return; }
    const view = this.layout.view();
    this.number.text = this.count || '0/0'; this.number.show();
    const tooltip = new vscode.MarkdownString();
    if (this.error) { tooltip.appendText(this.error); tooltip.appendMarkdown('\n\n'); }
    tooltip.appendMarkdown(this.error
      ? '[显示浏览器检查](command:idlepage.showBrowser) · [返回阅读](command:idlepage.returnReading) · [重试](command:idlepage.retryReading)'
      : '[上一段](command:idlepage.previousSegment) · [下一段](command:idlepage.nextSegment) · [下一章](command:idlepage.nextChapter) · [隐藏阅读](command:idlepage.toggleReading)\n\nAlt+→ / Alt+← 翻段，Alt+↓ 下一章，Alt+H 隐藏/恢复');
    tooltip.isTrusted = { enabledCommands: ['idlepage.showBrowser', 'idlepage.returnReading', 'idlepage.retryReading', 'idlepage.previousSegment', 'idlepage.nextSegment', 'idlepage.nextChapter', 'idlepage.toggleReading'] };
    const chunks = this.error ? [this.error] : splitStatusText(view.text || ' ', perItemCells);
    // Partition by the same measured units used for pagination, never truncate.
    while (this.bodies.length < chunks.length) this.bodies.push(vscode.window.createStatusBarItem('idlepage.readingText' + this.bodies.length, vscode.StatusBarAlignment.Left, -2 - this.bodies.length));
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
  dispose() { this.changed.dispose(); this.geometry.dispose(); for (const item of [this.number, ...this.bodies, this.progress, this.back]) item.dispose(); }
}
