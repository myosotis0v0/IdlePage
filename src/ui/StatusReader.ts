import * as vscode from 'vscode';
import { ReadingText } from '../application/ReadingText';
import { WindowWidth } from '../infrastructure/WindowWidth';

export class StatusReader implements vscode.Disposable {
  private number = vscode.window.createStatusBarItem('idlepage.chapterNumber', vscode.StatusBarAlignment.Left, -1);
  private body = vscode.window.createStatusBarItem('idlepage.readingText', vscode.StatusBarAlignment.Left, -2);
  private progress = vscode.window.createStatusBarItem('idlepage.chapterProgress', vscode.StatusBarAlignment.Left, -3);
  private back = vscode.window.createStatusBarItem('idlepage.returnReading', vscode.StatusBarAlignment.Left, -4);
  private layout = new ReadingText();
  private width = 1000;
  private count = '';
  private hidden = false;
  private error?: string;
  private geometry = new WindowWidth(width => { if (vscode.window.state.focused && this.width !== width) { this.width = width; this.render(); } });
  constructor() {
    this.number.name = '余页章节'; this.body.name = '余页正文'; this.progress.name = '余页进度'; this.back.name = '余页返回阅读';
    this.body.command = 'idlepage.nextSegment'; this.back.command = 'idlepage.returnReading'; this.back.text = '$(arrow-left) 返回阅读';
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
    this.layout.resize(this.width / Math.pow(1.2, zoom) * percentage / 100 / 13);
    if (this.hidden || !this.count && !this.error) { for (const item of [this.number, this.body, this.progress, this.back]) item.hide(); return; }
    const view = this.layout.view();
    this.number.text = this.count || '0/0'; this.number.show();
    this.body.text = this.error ? `$(warning) ${this.error} · 显示浏览器检查` : view.text || ' ';
    this.body.command = this.error ? 'idlepage.showBrowser' : 'idlepage.nextSegment';
    this.body.backgroundColor = this.error ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(this.error
      ? '[显示浏览器检查](command:idlepage.showBrowser) · [返回阅读](command:idlepage.returnReading) · [重试](command:idlepage.retryReading)'
      : '[上一段](command:idlepage.previousSegment) · [下一段](command:idlepage.nextSegment) · [下一章](command:idlepage.nextChapter) · [隐藏阅读](command:idlepage.toggleReading)\n\nAlt+→ / Alt+← 翻段，Alt+↓ 下一章，Alt+H 隐藏/恢复');
    tooltip.isTrusted = { enabledCommands: ['idlepage.showBrowser', 'idlepage.returnReading', 'idlepage.retryReading', 'idlepage.previousSegment', 'idlepage.nextSegment', 'idlepage.nextChapter', 'idlepage.toggleReading'] };
    this.body.tooltip = tooltip; this.body.show();
    this.progress.text = `${view.progress}%`; this.progress.show();
    if (this.error) this.back.show(); else this.back.hide();
  }
  dispose() { this.geometry.dispose(); for (const item of [this.number, this.body, this.progress, this.back]) item.dispose(); }
}
