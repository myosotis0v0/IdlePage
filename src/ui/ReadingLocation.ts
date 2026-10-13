import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { StatusReader } from './StatusReader';

type Location = 'statusBar' | 'sidebar' | 'panel';
const choices: { label: string; value: Location; detail: string }[] = [
  { label: '状态栏', value: 'statusBar', detail: '保留原有章节号、正文和进度显示' },
  { label: '侧栏阅读区', value: 'sidebar', detail: '与 Codex 上下排列；未安装 Codex 时放在资源管理器中' },
  { label: '底部面板', value: 'panel', detail: '在编辑器下方显示阅读区' },
];

/** A single real reading view shares navigation and state with the native reader. */
export class ReadingLocation implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private applying = Promise.resolve();
  private wasHidden = false;
  constructor(private reader: StatusReader) {
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider('idlepage.reader', this, { webviewOptions: { retainContextWhenHidden: true } }),
      reader.onDidChange(() => this.update()),
      vscode.commands.registerCommand('idlepage.selectReadingLocation', async () => {
        const current = this.location();
        const selected = await vscode.window.showQuickPick(choices.map(item => ({ ...item, description: item.value === current ? '当前' : undefined })), { title: '余页 · 文本显示位置', placeHolder: '选择正文显示的位置，阅读进度保持不变' });
        if (!selected) return;
        await vscode.workspace.getConfiguration('idlepage').update('reading.location', selected.value, vscode.ConfigurationTarget.Global);
        await this.apply();
      }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('idlepage.reading.location')) void this.apply(); }),
    );
    void this.apply();
  }
  private location(): Location { return vscode.workspace.getConfiguration('idlepage').get<Location>('reading.location', 'statusBar'); }
  private apply() {
    this.applying = this.applying.then(async () => {
      const location = this.location();
      await vscode.commands.executeCommand('setContext', 'idlepage.webviewReading', location !== 'statusBar');
      this.reader.render();
      if (location === 'statusBar' || this.reader.state().hidden) return;
      const destinationId = location === 'panel' ? 'workbench.view.extension.idlepage-reader' : vscode.extensions.getExtension('openai.chatgpt') ? 'workbench.view.extension.codexSecondaryViewContainer' : 'workbench.view.explorer';
      if (location === 'sidebar' && vscode.extensions.getExtension('openai.chatgpt')) await vscode.commands.executeCommand('chatgpt.sidebarSecondaryView.focus');
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['idlepage.reader'], destinationId });
      if (location === 'panel') await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('idlepage.reader.focus');
    }).catch(() => { void vscode.window.showWarningMessage('阅读视图位置调整失败，可重新选择显示位置或手动拖动阅读视图。'); });
    return this.applying;
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = readingLocationHtml();
    const allowed = new Set(['previousSegment', 'nextSegment', 'nextChapter', 'toggleReading', 'showBrowser', 'returnReading', 'retryReading']);
    this.subscriptions.push(view.webview.onDidReceiveMessage(message => {
      if (message?.ready) this.update();
      else if (allowed.has(message?.command)) {
        const state = this.reader.state();
        if (message.wheel && (!view.visible || this.location() === 'statusBar' || !state.count || state.hidden || state.error)) return;
        void vscode.commands.executeCommand('idlepage.' + message.command);
      }
    }), view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    this.update();
  }
  private update() {
    const state = this.reader.state(), restoring = this.wasHidden && !state.hidden;
    this.wasHidden = state.hidden;
    if (this.view) void this.view.webview.postMessage(state);
    if (restoring && this.location() !== 'statusBar') void this.apply();
  }
  dispose() { this.subscriptions.forEach(item => item.dispose()); }
}

export function readingLocationHtml() {
    const nonce = randomBytes(16).toString('hex');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
      *{box-sizing:border-box}html,body{height:100%;margin:0}body{color:var(--vscode-foreground);font:13px var(--vscode-font-family);padding:6px 10px;display:flex;flex-direction:column;gap:5px}header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--vscode-descriptionForeground)}#progress{margin-left:auto}button{border:0;background:transparent;color:var(--vscode-textLink-foreground);cursor:pointer;padding:2px;font:inherit}button:hover{text-decoration:underline}main{overflow:auto;flex:1;min-height:0;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}#error{color:var(--vscode-editorWarning-foreground)}[hidden]{display:none!important}
      </style></head><body><header><span id="count"></span><button data-command="previousSegment">上一段</button><button data-command="nextSegment">下一段</button><button data-command="nextChapter">下一章</button><button data-command="toggleReading">隐藏/恢复</button><span id="progress"></span></header><div id="error" hidden><span></span> <button data-command="showBrowser">显示浏览器检查</button> <button data-command="returnReading">返回阅读</button> <button data-command="retryReading">重试</button></div><main id="text">从书本菜单进入书架，选择章节开始阅读。</main><script nonce="${nonce}">
      const api=acquireVsCodeApi(),text=document.getElementById('text');let readable=false,lastWheel=-Infinity,lastTurn=-Infinity,burst=false;
      document.querySelectorAll('button').forEach(b=>b.onclick=()=>api.postMessage({command:b.dataset.command}));
      window.addEventListener('message',e=>{const s=e.data;readable=!!s.count&&!s.hidden&&!s.error;document.getElementById('count').textContent=s.count;document.getElementById('progress').textContent=s.count?s.progress+'%':'';const error=document.getElementById('error');error.hidden=!s.error;error.querySelector('span').textContent=s.error||'';const value=s.hidden?'阅读已隐藏':s.error?'':s.text?s.text.replace(/\u200b/g,''):'从书本菜单进入书架，选择章节开始阅读。';if(text.textContent!==value){text.textContent=value;text.scrollTop=0;}});
      text.addEventListener('wheel',e=>{
        const r=text.getBoundingClientRect();
        if(!readable||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||!e.deltaY||Math.abs(e.deltaX)>Math.abs(e.deltaY)||e.clientX<r.left||e.clientX>=r.right||e.clientY<r.top||e.clientY>=r.bottom)return;
        const now=performance.now();if(now-lastWheel>180)burst=false;lastWheel=now;
        if(burst){e.preventDefault();return;}
        const down=e.deltaY>0;
        // Let the reader see overflow before permitting a turn at that edge.
        if(down?text.scrollTop+text.clientHeight<text.scrollHeight-1:text.scrollTop>1){lastTurn=now;return;}
        e.preventDefault();if(now-lastTurn<350)return;
        burst=true;lastTurn=now;api.postMessage({command:down?'nextSegment':'previousSegment',wheel:true});
      },{passive:false});
      api.postMessage({ready:true});
      </script></body></html>`;
}
