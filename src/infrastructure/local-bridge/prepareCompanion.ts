import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const companionFiles = ['manifest.json', 'worker.js', 'remote.js', 'bookshelf.js', 'login.js', 'catalog.js', 'chapter.js', 'content.js', 'status.html', 'status.js'];
/** Files earlier versions placed in the paired copy; removed so no stale code lingers there. */
export const obsoleteCompanionFiles = ['offscreen.html', 'offscreen.js'];

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

/** Placeholder origin carrying the paired copy's build stamp (`.invalid` never resolves). */
export const buildOrigin = (build: string) => `https://b${build}.idlepage.invalid`;

/** Host permission for a remote server origin; a match pattern covers every port of the host. */
export function remotePattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function prepareCompanion(extensionPath: string, storagePath: string, endpoint: string, token: string, remotes: string[] = []): Promise<{ directory: string; origin: string }> {
  const source = join(extensionPath, 'browser-extension');
  const origin = await readCompanionOrigin(extensionPath);
  const directory = join(storagePath, 'companion');
  await mkdir(directory, { recursive: true });
  const files = new Map<string, string>();
  for (const file of companionFiles) if (file !== 'manifest.json') files.set(file, await readFile(join(source, file), 'utf8'));
  const template = await readFile(join(source, 'manifest.json'), 'utf8');
  // Edge keeps running an extension's old service-worker code (including imported modules) across
  // restarts until the extension reloads itself. Every worker version, old ones included, reloads when
  // pairing.json lists an origin its loaded manifest lacks; so the build stamp travels as a placeholder
  // origin that is also added to the new manifest. It never resolves and is never contacted.
  const build = createHash('sha256').update([template, ...remotes, ...[...files].map(([name, text]) => `${name}\n${text}`)].join('\0')).digest('hex').slice(0, 16);
  const paired = [...remotes, buildOrigin(build)];
  // Configured remote servers become host permissions of this paired copy only.
  const manifest = JSON.parse(template);
  manifest.host_permissions = [...new Set([...manifest.host_permissions, ...paired.map(remotePattern)])];
  files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  for (const [file, text] of files) await writeFile(join(directory, file), text, 'utf8');
  for (const file of obsoleteCompanionFiles) await rm(join(directory, file), { force: true });
  // Local paired copy only. This file is never part of the source or VSIX.
  await writeFile(join(directory, 'pairing.js'), `export const endpoint = ${JSON.stringify(endpoint)};\nexport const token = ${JSON.stringify(token)};\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(join(directory, 'pairing.json'), JSON.stringify({ endpoint, token, remotes: paired }) + '\n', { encoding: 'utf8', mode: 0o600 });
  return { directory, origin };
}
