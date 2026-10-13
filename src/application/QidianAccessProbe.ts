import { parseBookshelfPage, type BookshelfPage } from '../domain/bookshelf';
import { parseCatalogBatch, type CatalogResult } from '../domain/catalog';
import { randomUUID } from 'node:crypto';
import { parseObservation, type AccessReport, type BrowserTask } from '../domain/browserBridge';

export class QidianAccessProbe {
  private task: BrowserTask | null = this.createTask('access');
  private report?: AccessReport;
  private bookshelf?: BookshelfPage;
  private catalog?: CatalogResult;
  private catalogGoal = false;
  private phase = 'waiting-access';
  private lastSeenAt?: string;

  private createTask(kind: BrowserTask['kind']): BrowserTask {
    return { id: randomUUID(), kind, url: kind === 'access' ? 'https://www.qidian.com/' : 'https://my.qidian.com/bookcase/' };
  }
  nextTask(): BrowserTask | null {
    this.lastSeenAt = new Date().toISOString();
    return this.task ? { ...this.task } : null;
  }
  accept(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    if (!this.task || taskId !== this.task.id) return 'stale';
    const observation = parseObservation(value);
    if (!observation) return 'invalid';
    this.lastSeenAt = new Date().toISOString();
    this.report = { ...observation, taskKind: this.task.kind, observedAt: this.lastSeenAt };
    if (observation.state === 'SiteContentVisible') {
      if (this.task.kind === 'access') {
        this.task = this.createTask('bookshelf'); this.phase = 'waiting-bookshelf';
      } else if (this.task.kind === 'bookshelf' && observation.pageKind === 'bookshelf') {
        this.task = null; this.phase = 'probe-complete';
      }
    }
    return 'accepted';
  }
  startBookshelfExtraction(forCatalog = false): void {
    this.catalogGoal = forCatalog; this.catalog = undefined;
    this.task = this.createTask('bookshelf-list'); this.report = undefined; this.bookshelf = undefined;
    this.phase = 'waiting-bookshelf-list';
  }
  acceptBookshelf(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    if (!this.task || this.task.kind !== 'bookshelf-list' || taskId !== this.task.id) return 'stale';
    if (this.report?.state !== 'SiteContentVisible' || this.report.pageKind !== 'bookshelf') return 'invalid';
    const page = parseBookshelfPage(value);
    if (!page || !page.books.length) return 'invalid';
    this.bookshelf = page; this.task = null; this.lastSeenAt = new Date().toISOString();
    this.phase = page.strategy === 'unconfirmed' ? 'bookshelf-candidates-ready' : 'bookshelf-page-ready';
    if (this.catalogGoal && page.strategy !== 'unconfirmed') this.beginCatalog(page.books[0].id);
    return 'accepted';
  }
  private beginCatalog(bookId: string): void {
    this.task = { id: randomUUID(), kind: 'catalog', bookId, url: `https://www.qidian.com/book/${bookId}/#Catalog` };
    this.report = undefined; this.catalog = undefined; this.phase = 'waiting-catalog';
  }
  startCatalogExtraction(): void {
    this.catalogGoal = true;
    if (this.bookshelf?.strategy !== 'unconfirmed' && this.bookshelf?.books[0]) this.beginCatalog(this.bookshelf.books[0].id);
    else this.startBookshelfExtraction(true);
  }
  acceptCatalog(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    if (!this.task || this.task.kind !== 'catalog' || this.task.id !== taskId) return 'stale';
    if (this.report?.state !== 'SiteContentVisible' || this.report.pageKind !== 'book') return 'invalid';
    const batch = parseCatalogBatch(value);
    if (!batch || batch.bookId !== this.task.bookId) return 'invalid';
    if (!batch.total) { this.phase = 'catalog-not-ready'; return 'accepted'; }
    if (!this.catalog) {
      if (batch.offset !== 0) return 'invalid';
      const { offset: _, ...meta } = batch;
      this.catalog = { ...meta, chapters: [] };
    }
    const catalog = this.catalog;
    if (catalog.total !== batch.total || catalog.strategy !== batch.strategy || catalog.declaredCount !== batch.declaredCount || catalog.truncated !== batch.truncated) return 'invalid';
    if (batch.offset < catalog.chapters.length) {
      return JSON.stringify(catalog.chapters.slice(batch.offset, batch.offset + batch.chapters.length)) === JSON.stringify(batch.chapters) ? 'accepted' : 'invalid';
    }
    if (batch.offset !== catalog.chapters.length) return 'invalid';
    const ids = new Set(catalog.chapters.map(c => c.id));
    for (const chapter of batch.chapters) { if (ids.has(chapter.id)) return 'invalid'; ids.add(chapter.id); }
    catalog.chapters.push(...batch.chapters); this.lastSeenAt = new Date().toISOString();
    this.phase = 'receiving-catalog';
    if (catalog.chapters.length === catalog.total) { this.task = null; this.phase = 'catalog-preview-ready'; }
    return 'accepted';
  }
  getCatalog(): CatalogResult | undefined { return this.catalog ? structuredClone(this.catalog) : undefined; }
  getBookshelf(): BookshelfPage | undefined { return this.bookshelf ? structuredClone(this.bookshelf) : undefined; }
  snapshot() {
    return { phase: this.phase, lastSeenAt: this.lastSeenAt, report: this.report ? { ...this.report } : undefined,
      catalogSummary: this.catalog ? { count: this.catalog.chapters.length, total: this.catalog.total, declaredCount: this.catalog.declaredCount, truncated: this.catalog.truncated, strategy: this.catalog.strategy, free: this.catalog.chapters.filter(c => c.payment === 'free').length, paid: this.catalog.chapters.filter(c => c.payment === 'paid').length, unknown: this.catalog.chapters.filter(c => c.payment === 'unknown').length } : undefined,
      bookshelfSummary: this.bookshelf ? { count: this.bookshelf.books.length, truncated: this.bookshelf.truncated, strategy: this.bookshelf.strategy, pagination: this.bookshelf.pagination, containerHints: [...this.bookshelf.containerHints] } : undefined };
  }
  restart(): void {
    this.task = this.createTask('access'); this.report = undefined; this.bookshelf = undefined; this.catalog = undefined; this.catalogGoal = false; this.phase = 'waiting-access';
  }
}
