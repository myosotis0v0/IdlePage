import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateNextVersion } from '../../scripts/prepare-release.mjs';

const script = resolve('scripts/prepare-release.mjs');
function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
function git(cwd, ...args) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  mkdirSync('.local', { recursive: true });
  const directory = mkdtempSync(resolve('.local/release-test-'));
  const remote = join(directory, 'remote.git');
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  git(directory, 'init', '--bare', remote);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release test');
  git(repo, 'config', 'user.email', 'release-test@example.invalid');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.3' }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ version: '0.0.3', packages: { '': { version: '0.0.3' } } }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  return { repo, remote, output: join(directory, 'output.txt') };
}

test('version entry accepts prepared versions and numeric upgrades, rejects invalid or lower versions', () => {
  for (const version of ['0.0.3', '0.0.4', '0.1.0', '1.0.0']) validateNextVersion('0.0.3', version);
  validateNextVersion('0.9.9', '0.10.0');
  for (const version of ['0.0.2', 'v0.0.4', '00.0.4', '0.0.4-beta', '0.0.4\n', '0.0.4;echo bad', undefined]) {
    assert.throws(() => validateNextVersion('0.0.3', version));
  }
});

test('dry run preserves refs; preparation pushes matching manifest, lock and tag; duplicate is rejected', () => {
  const { repo, remote, output } = fixture();
  const before = git(remote, 'rev-parse', 'main');
  const env = { NEXT_VERSION: '0.0.4', GITHUB_OUTPUT: output };
  assert.equal(run(process.execPath, [script, '--dry-run'], repo, env).status, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), before);
  assert.equal(git(remote, 'tag'), '');
  const prepared = run(process.execPath, [script], repo, env);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(git(remote, 'rev-parse', 'main'), git(remote, 'rev-parse', 'v0.0.4^{}'));
  assert.equal(JSON.parse(git(remote, 'show', 'main:package.json')).version, '0.0.4');
  assert.equal(JSON.parse(git(remote, 'show', 'main:package-lock.json')).packages[''].version, '0.0.4');
  assert.equal(readFileSync(output, 'utf8'), 'tag=v0.0.4\n');
  const duplicate = run(process.execPath, [script], repo, env);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Tag already exists/);
});

test('stale main prevents version writes and tag creation', () => {
  const { repo, remote } = fixture();
  writeFileSync(join(repo, 'new.txt'), 'new main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'main advanced');
  git(repo, 'push', 'origin', 'main');
  git(repo, 'checkout', '--detach', 'HEAD~1');
  const result = run(process.execPath, [script], repo, { NEXT_VERSION: '0.0.4' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main changed/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '0.0.3');
  assert.equal(git(remote, 'tag'), '');
});
