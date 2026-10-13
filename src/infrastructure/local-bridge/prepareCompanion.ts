import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readCompanionOrigin(extensionPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(extensionPath, 'browser-extension', 'manifest.json'), 'utf8'));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).split('').map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  return `chrome-extension://${id}`;
}

export async function readExistingPairingToken(storagePath: string): Promise<string | undefined> {
  try {
    const source = await readFile(join(storagePath, 'companion', 'pairing.js'), 'utf8');
    // Parse only our generated data file; never execute local JavaScript.
    return /^export const endpoint = "http:\/\/127\.0\.0\.1:\d{1,5}";\r?\nexport const token = "([a-f0-9]{64})";\r?\n?$/.exec(source)?.[1];
  } catch { return undefined; }
}

export async function prepareCompanion(extensionPath: string, storagePath: string, endpoint: string, token: string): Promise<{ directory: string; origin: string }> {
  const source = join(extensionPath, 'browser-extension');
  const origin = await readCompanionOrigin(extensionPath);
  const directory = join(storagePath, 'companion');
  await mkdir(directory, { recursive: true });
  for (const file of ['manifest.json', 'worker.js', 'bookshelf.js', 'login.js', 'catalog.js', 'chapter.js', 'content.js', 'status.html', 'status.js']) await copyFile(join(source, file), join(directory, file));
  // Local paired copy only. This file is never part of the source or VSIX.
  await writeFile(join(directory, 'pairing.js'), `export const endpoint = ${JSON.stringify(endpoint)};\nexport const token = ${JSON.stringify(token)};\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(join(directory, 'pairing.json'), JSON.stringify({ endpoint, token }) + '\n', { encoding: 'utf8', mode: 0o600 });
  return { directory, origin };
}
