import * as vscode from 'vscode';
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
  const update = () => {
    const snapshot = probe.snapshot();
    const state = snapshot.report?.state;
    const display = snapshot.phase === 'probe-complete' ? '书架访问完成' :
      state === 'AccessBlocked' ? '访问受阻' : state === 'NeedsLogin' ? '需要登录' :
      snapshot.lastSeenAt ? '浏览器已连接' : '等待浏览器';
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
    bridge = new LocalBridgeServer({ port, token, origin, probe, onChanged: update });
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
    );
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
