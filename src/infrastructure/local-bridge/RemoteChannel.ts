import { randomUUID } from 'node:crypto';

/** One operation the paired browser runs inside a page on the remote server's origin. */
export type RemoteJob =
  | { op: 'fetch'; origin: string; home: string; path: string; method: 'GET' | 'POST' | 'PUT'; body?: string }
  | { op: 'play'; origin: string; home: string; path: string; player: string }
  | { op: 'login'; origin: string; path: string }
  | { op: 'login-done'; origin: string };
export interface RemoteResult { status?: number; type?: string; text?: string; error?: string; ok?: boolean; played?: boolean }

interface Pending { id: string; job: RemoteJob; resolve(result: RemoteResult): void; timer: ReturnType<typeof setTimeout>; taken: boolean }

/**
 * Loopback queue between VS Code and the browser companion. The companion long-polls
 * `take`; VS Code awaits `run`. Nothing here talks to the network itself.
 */
export class RemoteChannel {
  private queue: Pending[] = [];
  private pending = new Map<string, Pending>();
  private waiters: Array<(job?: Pending) => void> = [];
  private lastTake = 0;
  /** Set while a remote server is configured; tells the companion to keep its long poll running. */
  wanted = false;
  constructor(private readonly options: { holdMs?: number; liveMs?: number } = {}) {}
  /** True while the companion polled recently enough to pick up a job promptly. */
  connected(now = Date.now()): boolean { return now - this.lastTake < (this.options.liveMs ?? 15000); }
  run(job: RemoteJob, timeoutMs = 20000): Promise<RemoteResult> {
    return new Promise(resolve => {
      const id = randomUUID();
      const entry: Pending = { id, job, taken: false, resolve, timer: setTimeout(() => {
        this.pending.delete(id); this.queue = this.queue.filter(item => item !== entry);
        resolve({ error: entry.taken ? 'Timeout' : 'NotPickedUp' });
      }, timeoutMs) };
      this.pending.set(id, entry);
      const waiter = this.waiters.shift();
      if (waiter) waiter(entry); else this.queue.push(entry);
    });
  }
  async take(): Promise<({ id: string } & RemoteJob) | undefined> {
    this.lastTake = Date.now();
    let entry = this.queue.shift();
    if (!entry) {
      entry = await new Promise<Pending | undefined>(resolve => {
        const waiter = (job?: Pending) => { clearTimeout(timer); resolve(job); };
        const timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); resolve(undefined); }, this.options.holdMs ?? 8000);
        this.waiters.push(waiter);
      });
      this.lastTake = Date.now();
    }
    if (!entry) return;
    entry.taken = true;
    return { id: entry.id, ...entry.job };
  }
  complete(id: unknown, result: unknown): boolean {
    if (typeof id !== 'string') return false;
    const entry = this.pending.get(id);
    if (!entry || !entry.taken) return false;
    this.pending.delete(id); clearTimeout(entry.timer);
    entry.resolve(parseResult(result));
    return true;
  }
  dispose(): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve({ error: 'Disposed' }); }
    this.pending.clear(); this.queue = [];
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}

function parseResult(value: unknown): RemoteResult {
  if (!value || typeof value !== 'object') return { error: 'InvalidResult' };
  const r = value as Record<string, unknown>;
  const out: RemoteResult = {};
  if (Number.isSafeInteger(r.status)) out.status = r.status as number;
  for (const key of ['type', 'text', 'error'] as const) if (typeof r[key] === 'string') out[key] = r[key] as string;
  for (const key of ['ok', 'played'] as const) if (typeof r[key] === 'boolean') out[key] = r[key] as boolean;
  return out;
}
