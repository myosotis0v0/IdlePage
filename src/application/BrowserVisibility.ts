import { BrowserWindowController, type BrowserWindowResult } from './BrowserWindowController';

interface Options {
  windows: BrowserWindowController;
  canHide(): boolean;
  onFailure?(): void;
  attempts?: number;
  delayMs?: number;
}

/** Bound window-creation retries; never poll the website or force diagnostic windows hidden. */
export class BrowserVisibility {
  private pending?: Promise<void>;
  private disposed = false;
  lastResult?: BrowserWindowResult;
  constructor(private readonly options: Options) {}
  dispose(): void { this.disposed = true; }
  requestHide(): Promise<void> {
    if (this.pending) return this.pending;
    const result = this.hide(); this.pending = result;
    void result.finally(() => { if (this.pending === result) this.pending = undefined; });
    return result;
  }
  private async hide(): Promise<void> {
    for (let attempt = 0; attempt < (this.options.attempts ?? 6); attempt++) {
      if (this.disposed || !this.options.canHide()) return;
      try {
        const result = await this.options.windows.hideAutomatically();
        if (!result) return;
        this.lastResult = result;
        if (result.status === 'ok') return;
        if (!['not-running', 'no-window'].includes(result.status)) break;
      } catch { break; }
      await new Promise(resolve => setTimeout(resolve, this.options.delayMs ?? 250));
    }
    if (!this.disposed && this.options.canHide() && this.options.windows.mode === 'managed') this.options.onFailure?.();
  }
}
