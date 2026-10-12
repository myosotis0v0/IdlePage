import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readCompanionOrigin(extensionPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(extensionPath, 'browser-extension', 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).split('').map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  return `chrome-extension://${id}`;
}

export async function prepareCompanion(extensionPath: string, storagePath: string, endpoint: string, token: string): Promise<{ directory: string; origin: string }> {
  const source = join(extensionPath, 'browser-extension');
  const origin = await readCompanionOrigin(extensionPath);
  const directory = join(storagePath, 'companion');
  await mkdir(directory, { recursive: true });
  for (const file of ['manifest.json', 'worker.js', 'content.js', 'status.html', 'status.js']) await copyFile(join(source, file), join(directory, file));
  // Local paired copy only. This file is never part of the source or VSIX.
  await writeFile(join(directory, 'pairing.js'), `export const endpoint = ${JSON.stringify(endpoint)};\nexport const token = ${JSON.stringify(token)};\n`, { encoding: 'utf8', mode: 0o600 });
  return { directory, origin };
}
