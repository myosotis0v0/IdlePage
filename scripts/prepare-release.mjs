import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateNextVersion(current, next) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(current) || !pattern.test(next ?? '')) throw new Error('Use a version such as 0.0.4, without v, whitespace or prerelease suffix');
  const a = current.split('.').map(BigInt);
  const b = next.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return;
    if (b[i] < a[i]) throw new Error('Release version cannot be lower than the current version');
  }
  // An already committed version bump may be tagged without another commit.
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function prepareRelease() {
  const next = process.env.NEXT_VERSION;
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  validateNextVersion(manifest.version, next);
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) throw new Error('Manifest and lock versions differ');
  if (git('status', '--porcelain')) throw new Error('Release requires a clean checkout');
  const tag = `v${next}`;
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) throw new Error('Tag already exists; rerun failed build jobs or choose a new version');
  const head = git('rev-parse', 'HEAD');
  const remoteHead = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (head !== remoteHead) throw new Error('main changed since this run started; start a new run from main');
  if (process.argv.includes('--dry-run')) {
    console.log(`Validated ${tag}; dry run made no changes`);
    return;
  }
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  if (manifest.version !== next) {
    manifest.version = lock.version = lock.packages[''].version = next;
    writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    git('add', 'package.json', 'package-lock.json');
    git('commit', '-m', `chore: release ${next}`);
  }
  git('tag', '-a', tag, '-m', `IdlePage ${tag}`);
  // No force push: a concurrent main update or existing tag aborts both refs.
  git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  console.log(`Prepared ${tag}; continue with the reusable build and draft workflow`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareRelease();
