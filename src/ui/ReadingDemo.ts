import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Visual prototype only: fixture text, no browser, bridge or reading-cache access. */
export class ReadingDemo implements vscode.WebviewViewProvider {
  constructor(private sidebar = false) {}
  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = readingDemoHtml(this.sidebar);
    view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'hide') void vscode.commands.executeCommand(this.sidebar ? 'workbench.action.closeAuxiliaryBar' : 'workbench.action.closePanel');
    });
  }
}
export function readingDemoHtml(sidebar = false) {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:12px 16px;color:var(--vscode-foreground);background:var(--vscode-panel-background,var(--vscode-editor-background));font:13px var(--vscode-font-family, sans-serif)}
.reading{display:grid;grid-template-columns:64px minmax(0,1fr) 44px;align-items:center;gap:14px;min-height:34px;border-bottom:1px solid var(--vscode-panel-border,transparent);padding-bottom:8px}
#number,#progress{font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground)}#progress{text-align:right}
#text{font-size:14px;line-height:26px;white-space:pre;overflow:hidden;cursor:pointer;outline-offset:2px;min-width:0}
#measure{position:absolute;visibility:hidden;white-space:pre;font-size:14px;line-height:26px;pointer-events:none}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}button{font:inherit;color:var(--vscode-foreground);background:transparent;border:1px solid transparent;border-radius:3px;padding:4px 8px;cursor:pointer}button:hover{background:var(--vscode-toolbar-hoverBackground)}button:focus-visible,#text:focus-visible{outline:1px solid var(--vscode-focusBorder)}button:disabled{opacity:.35;cursor:default}.muted{color:var(--vscode-descriptionForeground);font-size:11px}.spacer{flex:1}#failure{display:none;color:var(--vscode-editorWarning-foreground);line-height:26px}body.failed #text{display:none}body.failed #failure{display:block}#return{display:none}body.failed #return{display:inline-block}
${sidebar ? '#text{white-space:pre-wrap;height:104px;overflow-wrap:anywhere}#measure{white-space:pre-wrap;overflow-wrap:anywhere;display:block}.reading{align-items:start;grid-template-columns:44px minmax(0,1fr) 36px;gap:8px}.muted{display:none}.controls{margin-top:6px;gap:3px}body{padding:8px 10px}' : ''}
</style></head><body>
<div class="reading"><span id="number">1/6</span><div id="text" tabindex="0" role="button" aria-label="正文，点击下一段"></div><span id="failure">读取失败，请显示浏览器检查</span><span id="progress">0%</span></div>
<div class="controls"><button id="previous">← 上一段</button><button id="next">下一段 →</button><button id="chapter">下一章</button><button id="return">返回阅读</button><span class="spacer"></span><span class="muted">示例正文 · 拖动面板边缘查看自适应效果</span><button id="error">模拟失败</button><button id="hide">隐藏</button></div>
<span id="measure" aria-hidden="true"></span>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const fixture='雨停之后，街道恢复了安静。窗边的灯还亮着，桌上的书翻到了一半。他把书签放回原处，听见楼下传来轻轻的脚步声。远处最后一班电车驶过路口，车窗里的灯光在积水上拖出细长的影子。没有人催促，他决定把这一页读完再出发。风从半开的窗户里吹进来，带来潮湿树叶的气息。时钟缓慢地走着，新的旅程似乎已经开始，却又像什么都没有发生。';
const text=Array.from(fixture.repeat(4));let offset=0,end=0,chapter=1;const history=[];
const el=id=>document.getElementById(id);const row=el('text'),measure=el('measure');
function render(){
 if(document.body.classList.contains('failed'))return;
 const width=Math.max(0,row.clientWidth-4);const multiline=${sidebar};if(multiline)measure.style.width=width+'px';let low=offset,high=text.length;
 while(low<high){const middle=Math.ceil((low+high)/2);measure.textContent=text.slice(offset,middle).join('');if(multiline?measure.getBoundingClientRect().height<=row.clientHeight:measure.getBoundingClientRect().width<=width)low=middle;else high=middle-1;}
 end=Math.max(offset+1,low);row.textContent=text.slice(offset,end).join('');
 el('number').textContent=chapter+'/6';el('progress').textContent=(offset===0?0:end>=text.length?100:Math.floor(offset/(text.length-1)*100))+'%';el('previous').disabled=!history.length;
}
function next(){if(document.body.classList.contains('failed'))return;if(end>=text.length){nextChapter();return;}history.push(offset);offset=end;render();}
function previous(){if(document.body.classList.contains('failed')||!history.length)return;offset=history.pop();render();}
function nextChapter(){if(document.body.classList.contains('failed')||chapter>=6)return;chapter++;offset=0;history.length=0;render();}
el('next').onclick=next;row.onclick=next;el('previous').onclick=previous;el('chapter').onclick=nextChapter;
el('error').onclick=()=>{document.body.classList.add('failed');};el('return').onclick=()=>{document.body.classList.remove('failed');render();};
el('hide').onclick=()=>vscode.postMessage({type:'hide'});
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();next();}else if(e.key==='ArrowLeft'){e.preventDefault();previous();}else if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();next();}});
new ResizeObserver(render).observe(row);document.fonts.ready.then(render);render();
</script></body></html>`;
}
