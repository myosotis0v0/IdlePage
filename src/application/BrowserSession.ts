interface BrowserSessionOptions {
  launch(): Promise<void>;
  isRunning?(): Promise<boolean>;
  isCurrent(taskId: string): boolean;
  hasObserved(taskId: string): boolean;
  onChanged?(): void;
  graceMs?: number;
  timeoutMs?: number;
  tickMs?: number;
}
export class BrowserSession {
  state: 'idle' | 'checking' | 'launching' | 'ready' | 'failed' = 'idle';
  private lastContact = 0;
  private pending?: { id: string; result: Promise<string> };
  private disposed = false;
  constructor(private readonly options: BrowserSessionOptions) {}
  noteContact(): void { this.lastContact = Date.now(); }
  forgetContact(): void { this.lastContact = 0; }
  dispose(): void { this.disposed = true; }
  private change(state: BrowserSession['state']) { this.state = state; this.options.onChanged?.(); }
  ensure(taskId: string): Promise<string> {
    if (this.pending?.id === taskId) return this.pending.result;
    const result = this.connect(taskId);
    this.pending = { id: taskId, result };
    void result.finally(() => { if (this.pending?.id === taskId) this.pending = undefined; });
    return result;
  }
  private async connect(taskId: string): Promise<string> {
    this.change('checking');
    const started = Date.now();
    const grace = this.options.graceMs ?? 35000;
    const timeout = this.options.timeoutMs ?? 40000;
    const launchAt = started - this.lastContact < 40000 ? started + grace : started;
    let launchedAt: number | undefined;
    for (;;) {
      if (this.options.hasObserved(taskId)) { this.change('ready'); return 'connected'; }
      if (this.disposed || !this.options.isCurrent(taskId)) return 'cancelled';
      const now = Date.now();
      if (launchedAt === undefined && now >= launchAt) {
        try {
          const running = await this.options.isRunning?.();
          if (this.disposed || !this.options.isCurrent(taskId)) return 'cancelled';
          if (!running) { this.change('launching'); await this.options.launch(); }
          launchedAt = Date.now();
        }
        catch { this.change('failed'); return 'launch-failed'; }
      }
      if (launchedAt !== undefined && now - launchedAt >= timeout) { this.change('failed'); return 'connection-timeout'; }
      await new Promise(resolve => setTimeout(resolve, this.options.tickMs ?? 250));
    }
  }
}
