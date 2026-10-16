import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareCompanion, readExistingPairingToken } from '../../src/infrastructure/local-bridge/prepareCompanion';
test('private pairing credential survives host restart and arbitrary local code is not executed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'idlepage-pairing-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'companion'));
  const file = join(root, 'companion/pairing.js'); const token = 'a'.repeat(64);
  await writeFile(file, `export const endpoint = "http://127.0.0.1:17655";\nexport const token = "${token}";\n`);
  assert.equal(await readExistingPairingToken(root), token);
  assert.equal(await readExistingPairingToken(root), token);
  await writeFile(file, `export const endpoint = "https://evil.example";\nexport const token = "${token}";\n`);
  assert.equal(await readExistingPairingToken(root), undefined);
  await writeFile(file, 'throw new Error("must not run")'); assert.equal(await readExistingPairingToken(root), undefined);
});

test('paired copy carries its build stamp as a placeholder origin granted by its manifest, and drops obsolete files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'idlepage-pairing-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'companion'));
  await writeFile(join(root, 'companion/offscreen.js'), 'old');
  const prepare = async (remotes: string[]) => {
    const { directory } = await prepareCompanion(process.cwd(), root, 'http://127.0.0.1:17655', 'a'.repeat(64), remotes);
    return { pairing: JSON.parse(await readFile(join(directory, 'pairing.json'), 'utf8')), manifest: JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), directory };
  };
  const first = await prepare(['https://study.example']);
  // Only keys every worker version accepts: an old resident worker must still read this file.
  assert.deepEqual(Object.keys(first.pairing), ['endpoint', 'token', 'remotes']);
  const [server, stamp] = first.pairing.remotes;
  assert.equal(server, 'https://study.example');
  assert.match(stamp, /^https:\/\/b[a-f0-9]{16}\.idlepage\.invalid$/);
  assert.ok(first.manifest.host_permissions.includes(`https://${new URL(stamp).hostname}/*`));
  await assert.rejects(access(join(first.directory, 'offscreen.js')));
  // Same sources, same stamp (no needless reload); another server changes the stamp.
  assert.equal((await prepare(['https://study.example'])).pairing.remotes[1], stamp);
  assert.notEqual((await prepare(['https://other.example'])).pairing.remotes[1], stamp);
});
