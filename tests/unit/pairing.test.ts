import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readExistingPairingToken } from '../../src/infrastructure/local-bridge/prepareCompanion';
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
