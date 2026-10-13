import { parseBookshelfPage, type BookshelfPage } from '../domain/bookshelf';
import { randomUUID } from 'node:crypto';
import { parseObservation, type AccessReport, type BrowserTask } from '../domain/browserBridge';

export class QidianAccessProbe {
  private task: BrowserTask | null = this.createTask('access');
  private report?: AccessReport;
  private bookshelf?: BookshelfPage;
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
  startBookshelfExtraction(): void {
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
    return 'accepted';
  }
  getBookshelf(): BookshelfPage | undefined { return this.bookshelf ? structuredClone(this.bookshelf) : undefined; }
  snapshot() {
    return { phase: this.phase, lastSeenAt: this.lastSeenAt, report: this.report ? { ...this.report } : undefined,
      bookshelfSummary: this.bookshelf ? { count: this.bookshelf.books.length, truncated: this.bookshelf.truncated, strategy: this.bookshelf.strategy, pagination: this.bookshelf.pagination, containerHints: [...this.bookshelf.containerHints] } : undefined };
  }
  restart(): void {
    this.task = this.createTask('access'); this.report = undefined; this.bookshelf = undefined; this.phase = 'waiting-access';
  }
}
