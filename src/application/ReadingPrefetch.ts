import type { QidianAccessProbe } from './QidianAccessProbe';
import type { CachedChapter } from '../domain/readingCache';

interface Cache {
  chapter(book: string, chapter: string): Promise<CachedChapter | undefined>;
  saveChapter(chapter: CachedChapter): Promise<boolean>;
}
/** One serial three-chapter horizon. Browser results never commit a reading position. */
export class ReadingPrefetch {
  private generation = 0;
  private revision = -1;
  private enabled = false;
  private working = false;
  private cursor = 0;
  private targets: Array<{ bookId: string; id: string; url: string; index: number }> = [];
  private disposed = false;
  constructor(private probe: QidianAccessProbe, private cache: Cache | undefined,
    private changed: () => void, private startBrowser: () => void, private fail: (reason: string) => void) {}
  pause() { this.generation++; this.enabled = false; this.probe.cancelPrefetch(); }
  dispose() { this.disposed = true; this.pause(); }
  retry() { this.revision = -1; this.sync(); }
  sync() {
    if (this.disposed) return;
    const reading = this.probe.readingContext();
    if (reading && reading.revision !== this.revision) {
      this.generation++; this.revision = reading.revision; this.enabled = true; this.cursor = 0;
      this.targets = reading.catalog.chapters.slice(reading.index + 1, reading.index + 4)
        .map((c, offset) => ({ bookId: reading.catalog.bookId, id: c.id, url: c.url, index: reading.index + offset + 1 }));
    }
    if (!this.enabled || this.working || this.probe.currentTaskId()) return;
    this.working = true;
    const generation = this.generation;
    void this.run(generation).catch(() => { if (generation === this.generation) this.stop('cache-error'); })
      .finally(() => { this.working = false; if (generation !== this.generation) this.sync(); });
  }
  private current(generation: number) { return !this.disposed && this.enabled && generation === this.generation; }
  private stop(reason: string) { this.enabled = false; this.fail(reason); }
  private async run(generation: number) {
    const result = this.probe.takePrefetchResult();
    if (result?.reason) { this.stop(result.reason); return; }
    if (!this.targets.length) { this.enabled = false; return; }
    if (!this.cache) { this.stop('cache-disabled'); return; }
    if (result?.chapter) {
      const saved = await this.cache.saveChapter(result.chapter);
      if (!this.current(generation)) return;
      if (!saved) { this.stop('cache-capacity'); return; }
      if (result.skippedIndex !== undefined) this.targets = this.targets.filter(target => target.index !== result.skippedIndex);
      const completed = this.targets.findIndex(target => target.id === result.chapter!.chapterId);
      // A failure at the horizon edge may fetch exactly one chapter beyond it.
      if (completed >= 0) this.cursor = completed + 1;
    }
    while (this.current(generation) && this.cursor < this.targets.length) {
      const target = this.targets[this.cursor];
      const cached = await this.cache.chapter(target.bookId, target.id);
      if (!this.current(generation) || this.probe.currentTaskId()) return;
      if (cached?.url === target.url) { this.cursor++; continue; }
      if (this.probe.startPrefetch(target.index)) { this.changed(); this.startBrowser(); }
      return;
    }
    // A small quota can accept each write while evicting earlier horizon entries.
    for (const target of this.targets) {
      const cached = await this.cache.chapter(target.bookId, target.id);
      if (!this.current(generation)) return;
      if (cached?.url !== target.url) { this.stop('cache-capacity'); return; }
    }
    this.enabled = false;
  }
}
