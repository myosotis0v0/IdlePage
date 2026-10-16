import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** 添加网址 with only the older single-address setting present: it asks, saves both and migrates the old key. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<{ getEntryStatus(): { tooltip: string } }>('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  const config = () => vscode.workspace.getConfiguration('idlepage');
  await config().update('remote.server', 'https://example.com/tools/music/ear-training/', vscode.ConfigurationTarget.Global);
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window.showInputBox;
  let asked: { validateInput?(value: string): unknown } | undefined;
  try {
    window.showInputBox = async (options: typeof asked) => { asked = options; return 'https://example.com/tools/language/vocab/'; };
    assert.equal(await vscode.commands.executeCommand('idlepage.study.addSite'), true);
    assert.ok(asked, 'an input box asked for the address');
    assert.ok(asked!.validateInput?.('https://example.com/tools/music/ear-training/'), 'an address already in the list is refused');
    assert.deepEqual(config().get('remote.servers'), ['https://example.com/tools/music/ear-training/', 'https://example.com/tools/language/vocab/']);
    assert.equal(config().inspect('remote.server')?.globalValue, undefined, 'the older single-address setting is migrated');
    await new Promise(r => setTimeout(r, 100));
    const rows = api.getEntryStatus().tooltip.split('\n').filter(line => line.includes('command:idlepage.study.removeSite'));
    assert.equal(rows.length, 2, 'one hover row per address');
    console.log('Add-site host test passed: asks, saves, migrates the old setting and shows one row per address.');
  } finally {
    window.showInputBox = original;
    await config().update('remote.servers', undefined, vscode.ConfigurationTarget.Global);
    await config().update('remote.server', undefined, vscode.ConfigurationTarget.Global);
  }
}
