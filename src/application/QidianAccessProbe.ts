import { randomUUID } from 'node:crypto';
import { parseObservation, type AccessReport, type BrowserTask } from '../domain/browserBridge';

export class QidianAccessProbe {
  private task: BrowserTask | null = this.createTask('access');
  private report?: AccessReport;
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
      } else if (observation.pageKind === 'bookshelf') {
        this.task = null; this.phase = 'probe-complete';
      }
    }
    return 'accepted';
  }
  snapshot() {
    return { phase: this.phase, lastSeenAt: this.lastSeenAt, report: this.report ? { ...this.report } : undefined };
  }
  restart(): void {
    this.task = this.createTask('access'); this.report = undefined; this.phase = 'waiting-access';
  }
}
