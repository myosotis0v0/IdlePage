import { parseBookshelfPage, type BookshelfPage } from '../domain/bookshelf';
import { parseChapterBatch, type ChapterResult } from '../domain/chapter';
import { parseCatalogBatch, type CatalogResult } from '../domain/catalog';
import { randomUUID } from 'node:crypto';
import type { CachedChapter } from '../domain/readingCache';
import { parseObservation, type AccessReport, type BrowserTask } from '../domain/browserBridge';

export class QidianAccessProbe {
  constructor(private readonly useCache = false) {}
  private revision = 0;
  private cacheTask?: string;
  private chapterSource: 'online' | 'cache' = 'online';
  private suspended?: BrowserTask;
  private recovered = false;
  private taskStarted = Infinity;
  private failure?: { reason: 'access-blocked' | 'timeout' | 'cancelled' | 'login-failed' | 'connection-failed'; sequence: number };
  private failureSequence = 0;
  private resetRecovery() { this.suspended = undefined; this.recovered = false; this.failure = undefined; this.taskStarted = Date.now(); }
  private waitForLogin() {
    if (this.task?.kind === 'login') return;
    if (this.recovered) { this.stop('login-failed'); return; }
    this.suspended = this.task ?? undefined;
    this.task = this.createTask('login'); this.taskStarted = Date.now();
    this.chapterDeadline = 0; this.chapterText = ''; this.chapterTotal = 0; this.cacheTask = undefined;
    if (this.suspended?.kind === 'catalog') this.catalog = undefined;
    this.phase = 'waiting-login';
  }
  private resumeAfterLogin() {
    if (!this.suspended) return;
    this.task = { ...this.suspended, id: randomUUID() }; this.suspended = undefined;
    this.recovered = true; this.taskStarted = Date.now(); this.report = undefined;
    this.phase = `waiting-${this.task.kind}`;
    if (this.task.kind === 'chapter') this.chapterDeadline = Date.now() + 90000;
  }
  cancel(): boolean { if (!this.task) return false; this.stop('cancelled'); return true; }
  failConnection(taskId: string): boolean { if (!this.isCurrentTask(taskId)) return false; this.stop('connection-failed'); return true; }
  private stop(reason: NonNullable<QidianAccessProbe['failure']>['reason']) {
    const chapter = this.task?.kind === 'chapter' || this.suspended?.kind === 'chapter';
    this.failure = { reason, sequence: ++this.failureSequence };
    this.suspended = undefined;
    if (chapter) this.finishChapter({ status: 'unavailable', reason });
    else { this.task = null; this.chapterDeadline = 0; this.phase = 'task-failed'; }
    if (reason === 'cancelled') { this.phase = 'cancelled'; this.report = undefined; }
  }
  cacheRevision() { return this.revision; }
  invalidateTask(): void {
    this.task = null; this.suspended = undefined; this.failure = undefined; this.report = undefined;
    this.chapterDeadline = 0; this.chapterText = ''; this.cacheTask = undefined; this.chapter = undefined;
    this.chapterGoal = false; this.phase = 'idle';
  }
  readingLocation() { return { bookId: this.readingCatalog?.bookId, chapterId: this.readingCatalog?.chapters[this.currentChapterIndex]?.id }; }
  private bookSelectionRevision = 0;
  selectBook(bookId: string, cached?: CatalogResult): boolean {
    if (!this.bookshelf?.books.some(book => book.id === bookId)) return false;
    this.bookSelectionRevision++;
    this.resetRecovery(); this.chapterGoal = false; this.catalogGoal = false;
    this.chapter = undefined; this.chapterText = ''; this.chapterDeadline = 0; this.report = undefined;
    if (cached?.bookId === bookId && cached.chapters.length === cached.total && cached.total > 0) {
      this.catalog = structuredClone(cached); this.task = null; this.phase = 'catalog-preview-ready';
    } else this.beginCatalog(bookId);
    return true;
  }
  selectChapter(bookId: string, chapterId: string): boolean {
    if (this.catalog?.bookId !== bookId || this.catalog.chapters.length !== this.catalog.total) return false;
    const index = this.catalog.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) return false;
    this.resetRecovery(); this.chapterGoal = true; this.chapter = undefined; this.beginChapter(index); return true;
  }
  restoreMetadata(shelf?: BookshelfPage, catalog?: CatalogResult) {
    this.bookshelf = shelf;
    if (catalog?.bookId === shelf?.books[0]?.id) this.catalog = catalog;
  }
  pendingCacheChapter() {
    if (!this.cacheTask || this.cacheTask !== this.task?.id || !this.catalog) return;
    return { taskId: this.cacheTask, bookId: this.catalog.bookId, ...this.catalog.chapters[this.pendingChapterIndex] };
  }
  resolveCachedChapter(taskId: string, cached?: CachedChapter): boolean {
    const pending = this.pendingCacheChapter();
    if (!pending || pending.taskId !== taskId) return false;
    this.cacheTask = undefined;
    if (cached && cached.bookId === pending.bookId && cached.chapterId === pending.id && cached.url === pending.url) {
      this.finishChapter({ status: 'available', title: pending.title, text: cached.text }, 'cache');
    } else { this.phase = 'waiting-chapter'; this.chapterDeadline = Date.now() + 90000; }
    return true;
  }
  cacheChapter(): CachedChapter | undefined {
    const chapter = this.readingCatalog?.chapters[this.currentChapterIndex];
    if (!chapter || !this.readingChapter || this.chapterSource !== 'online') return;
    return { bookId: this.readingCatalog!.bookId, chapterId: chapter.id, url: chapter.url, title: chapter.title, text: this.readingChapter.text };
  }
  private task: BrowserTask | null = this.createTask('access');
  private report?: AccessReport;
  private bookshelf?: BookshelfPage;
  private catalog?: CatalogResult;
  private catalogGoal = false;
  private chapterGoal = false;
  private chapter?: ChapterResult;
  private readingChapter?: Extract<ChapterResult, { status: 'available' }>;
  private readingCatalog?: CatalogResult;
  private currentChapterIndex = -1;
  private pendingChapterIndex = 0;
  private chapterText = '';
  private chapterTotal = 0;
  private chapterTitle = '';
  private chapterDeadline = 0;
  private chapterDiagnostics?: { paragraphs: number; containers: string[]; annotationNodes?: string[] };
  private phase = 'waiting-access';
  private lastSeenAt?: string;
  private observedTaskId?: string;
  hasObservedTask(taskId: string): boolean { return this.observedTaskId === taskId; }
  isCurrentTask(taskId: string): boolean { return this.task?.id === taskId; }
  currentTaskId(): string | undefined { return this.task?.id; }

  private createTask(kind: BrowserTask['kind']): BrowserTask {
    return { id: randomUUID(), kind, url: kind === 'access' ? 'https://www.qidian.com/' : 'https://my.qidian.com/bookcase/' };
  }
  nextTask(): BrowserTask | null {
    if (this.task && !Number.isFinite(this.taskStarted)) this.taskStarted = Date.now();
    this.expireChapter();
    this.lastSeenAt = new Date().toISOString();
    return this.task && !this.pendingCacheChapter() ? { ...this.task } : null;
  }
  accept(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    this.expireChapter();
    if (!this.task || taskId !== this.task.id) return 'stale';
    const observation = parseObservation(value);
    if (!observation) return 'invalid';
    this.observedTaskId = this.task.id;
    this.lastSeenAt = new Date().toISOString();
    this.report = { ...observation, taskKind: this.task.kind, observedAt: this.lastSeenAt };
    if (observation.state === 'AccessBlocked') {
      if (observation.pageKind === 'login' && !observation.tooFrequent) this.waitForLogin();
      else this.stop('access-blocked');
      return 'accepted';
    }
    if (observation.state === 'NeedsLogin') { this.waitForLogin(); return 'accepted'; }
    if (this.task.kind === 'login') {
      if (observation.state === 'SiteContentVisible' && observation.pageKind === 'bookshelf' && observation.loginEvidence) this.resumeAfterLogin();
      return 'accepted';
    }
    if (observation.state === 'SiteContentVisible') {
      if (this.task.kind === 'access') {
        this.task = this.createTask('bookshelf'); this.taskStarted = Date.now(); this.phase = 'waiting-bookshelf';
      } else if (this.task.kind === 'bookshelf' && observation.pageKind === 'bookshelf') {
        this.task = null; this.phase = 'probe-complete';
      }
    }
    return 'accepted';
  }
  startBookshelfExtraction(forCatalog = false): void {
    this.resetRecovery();
    if (!forCatalog) this.chapterGoal = false;
    this.chapterDeadline = 0; this.chapter = undefined; this.chapterText = '';
    this.catalogGoal = forCatalog; this.catalog = undefined;
    this.task = this.createTask('bookshelf-list'); this.report = undefined; this.bookshelf = undefined;
    this.phase = 'waiting-bookshelf-list';
  }
  acceptBookshelf(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    this.expireChapter();
    if (!this.task || this.task.kind !== 'bookshelf-list' || taskId !== this.task.id) return 'stale';
    if (this.report?.state !== 'SiteContentVisible' || this.report.pageKind !== 'bookshelf') return 'invalid';
    const page = parseBookshelfPage(value);
    if (!page || !page.books.length && page.strategy === 'unconfirmed') return 'invalid';
    this.bookshelf = page; this.revision++; this.task = null; this.lastSeenAt = new Date().toISOString();
    this.phase = page.strategy === 'unconfirmed' ? 'bookshelf-candidates-ready' : 'bookshelf-page-ready';
    if (this.catalogGoal && page.strategy !== 'unconfirmed' && page.books[0]) this.beginCatalog(page.books[0].id);
    return 'accepted';
  }
  private beginCatalog(bookId: string): void {
    this.taskStarted = Date.now();
    this.task = { id: randomUUID(), kind: 'catalog', bookId, url: `https://www.qidian.com/book/${bookId}/#Catalog` };
    this.report = undefined; this.catalog = undefined; this.phase = 'waiting-catalog';
  }
  startCatalogExtraction(forChapter = false): void {
    this.resetRecovery();
    if (!forChapter) this.chapterGoal = false;
    this.chapterDeadline = 0; this.chapter = undefined; this.chapterText = '';
    this.catalogGoal = true;
    if (this.bookshelf?.strategy !== 'unconfirmed' && this.bookshelf?.books[0]) this.beginCatalog(this.bookshelf.books[0].id);
    else this.startBookshelfExtraction(true);
  }
  startChapterExtraction(): void {
    this.resetRecovery();
    this.chapterGoal = true; this.chapter = undefined; this.chapterText = ''; this.chapterTotal = 0;
    if (this.catalog?.chapters.length === this.catalog?.total && this.catalog?.chapters[0]) this.beginChapter();
    else this.startCatalogExtraction(true);
  }
  startNextChapter(): 'started' | 'busy' | 'not-ready' | 'end' {
    if (this.task) return 'busy';
    if (!this.readingChapter || this.currentChapterIndex < 0 || !this.readingCatalog) return 'not-ready';
    this.catalog = this.readingCatalog;
    const next = this.currentChapterIndex + 1;
    if (next >= this.catalog.chapters.length) return 'end';
    this.resetRecovery();
    this.chapter = undefined; this.beginChapter(next); return 'started';
  }
  getReadingChapter() { return this.readingChapter ? structuredClone(this.readingChapter) : undefined; }
  private beginChapter(index = 0): void {
    this.taskStarted = Date.now();
    this.pendingChapterIndex = index;
    this.chapterDiagnostics = undefined;
    const chapter = this.catalog!.chapters[index];
    this.chapterTitle = chapter.title; this.chapterText = ''; this.chapterTotal = 0;
    this.chapterDeadline = Date.now() + 90000;
    this.task = { id: randomUUID(), kind: 'chapter', bookId: this.catalog!.bookId, url: chapter.url };
    this.report = undefined; this.phase = 'waiting-chapter';
    this.cacheTask = this.useCache ? this.task.id : undefined;
    if (this.cacheTask) { this.phase = 'checking-cache'; this.chapterDeadline = 0; }
  }
  private finishChapter(result: ChapterResult, source: 'online' | 'cache' = 'online'): void {
    if (result.status === 'available') { this.chapterSource = source; this.readingChapter = result; this.readingCatalog = this.catalog; this.currentChapterIndex = this.pendingChapterIndex; this.revision++; }
    this.chapter = result; this.task = null; this.chapterGoal = false; this.chapterText = ''; this.chapterDeadline = 0;
    this.phase = result.status === 'available' ? 'chapter-preview-ready' : 'chapter-unavailable';
  }
  expireChapter(now = Date.now()): boolean {
    if (!this.task || this.pendingCacheChapter()) return false;
    const deadline = this.task.kind === 'chapter' ? this.chapterDeadline : this.taskStarted + (this.task.kind === 'login' ? 10 * 60000 : 90000);
    if (!deadline || now < deadline) return false;
    this.stop('timeout'); return true;
  }
  acceptChapter(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    this.expireChapter();
    if (!this.task || this.task.kind !== 'chapter' || taskId !== this.task.id) return 'stale';
    const batch = parseChapterBatch(value); if (!batch) return 'invalid';
    if (batch.status === 'unavailable') {
      if (batch.reason === 'needs-login') this.waitForLogin();
      else this.finishChapter(batch);
      return 'accepted';
    }
    if (this.report?.state !== 'SiteContentVisible' || this.report.pageKind !== 'chapter') return 'invalid';
    if (this.chapterTotal && batch.total !== this.chapterTotal) return 'invalid';
    if (batch.offset < this.chapterText.length) return this.chapterText.slice(batch.offset, batch.offset + batch.text.length) === batch.text ? 'accepted' : 'invalid';
    if (batch.offset !== this.chapterText.length) return 'invalid';
    this.chapterTotal = batch.total; this.chapterText += batch.text; this.phase = 'receiving-chapter';
    if (this.chapterText.length === batch.total) this.finishChapter({ status: 'available', title: this.chapterTitle, text: this.chapterText });
    return 'accepted';
  }
  getChapter(): ChapterResult | undefined { return this.chapter ? structuredClone(this.chapter) : undefined; }
  acceptChapterDiagnostics(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    if (!this.task || this.task.kind !== 'chapter' || this.task.id !== taskId) return 'stale';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
    const r = value as Record<string, unknown>;
    const labels = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 12 && value.every(c => typeof c === 'string' && c.length <= 180 && /^[a-z][a-z0-9]*(?:[.#][a-zA-Z][a-zA-Z_-]{0,39})*$/.test(c));
    if (Object.keys(r).some(k => !['paragraphs', 'containers', 'annotationNodes'].includes(k)) || !Number.isSafeInteger(r.paragraphs) || (r.paragraphs as number) < 0 || (r.paragraphs as number) > 10000 || !labels(r.containers) || r.annotationNodes !== undefined && !labels(r.annotationNodes)) return 'invalid';
    this.chapterDiagnostics = { paragraphs: r.paragraphs as number, containers: [...r.containers], ...(r.annotationNodes ? { annotationNodes: r.annotationNodes as string[] } : {}) }; return 'accepted';
  }
  acceptCatalog(taskId: unknown, value: unknown): 'accepted' | 'stale' | 'invalid' {
    this.expireChapter();
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
    if (catalog.chapters.length === catalog.total) { this.revision++; this.task = null; this.phase = 'catalog-preview-ready'; if (this.chapterGoal) this.beginChapter(); }
    return 'accepted';
  }
  getCatalog(): CatalogResult | undefined { return this.catalog ? structuredClone(this.catalog) : undefined; }
  getBookshelf(): BookshelfPage | undefined { return this.bookshelf ? structuredClone(this.bookshelf) : undefined; }
  snapshot() {
    return { phase: this.phase, bookSelectionRevision: this.bookSelectionRevision, recovery: { waitingLogin: !!this.suspended, resumed: this.recovered }, failure: this.failure, chapterSource: this.chapterSource, lastSeenAt: this.lastSeenAt, report: this.report ? { ...this.report } : undefined,
      chapterNavigation: { current: this.currentChapterIndex + 1, total: (this.readingCatalog ?? this.catalog)?.chapters.length ?? 0, busy: !!this.task, canNext: !this.task && !!this.readingChapter && this.currentChapterIndex + 1 < (this.readingCatalog?.chapters.length ?? 0) },
      chapterSummary: this.chapter ? this.chapter.status === 'available' ? { status: 'available', characters: this.chapter.text.length } : { ...this.chapter } : undefined,
      chapterDiagnostics: this.chapterDiagnostics,
      catalogSummary: this.catalog ? { count: this.catalog.chapters.length, total: this.catalog.total, declaredCount: this.catalog.declaredCount, truncated: this.catalog.truncated, strategy: this.catalog.strategy, free: this.catalog.chapters.filter(c => c.payment === 'free').length, paid: this.catalog.chapters.filter(c => c.payment === 'paid').length, unknown: this.catalog.chapters.filter(c => c.payment === 'unknown').length } : undefined,
      bookshelfSummary: this.bookshelf ? { count: this.bookshelf.books.length, truncated: this.bookshelf.truncated, strategy: this.bookshelf.strategy, pagination: this.bookshelf.pagination, containerHints: [...this.bookshelf.containerHints] } : undefined };
  }
  restart(): void {
    this.resetRecovery();
    this.chapterGoal = false; this.chapter = undefined; this.chapterText = ''; this.chapterDeadline = 0;
    this.task = this.createTask('access'); this.report = undefined; this.bookshelf = undefined; this.catalog = undefined; this.catalogGoal = false; this.phase = 'waiting-access';
  }
}
