import { mkdir, readFile, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A private atomic metadata file, separate from the evictable chapter cache. */
export async function openProgressStorage(directory: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'reading-progress.json');
  let value: unknown;
  try {
    if ((await stat(file)).size > 1024 * 1024) throw new Error('ProgressFileTooLarge');
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    get<T>(_key: string) { return value as T | undefined; },
    async update(_key: string, next: unknown) {
      const temporary = file + '.tmp-' + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file); value = next;
      } finally { await unlink(temporary).catch(() => {}); }
    },
  };
}
