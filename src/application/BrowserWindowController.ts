export interface BrowserWindowResult {
  status: 'ok' | 'not-running' | 'no-window' | 'ambiguous' | 'failed';
  windows: number;
  visible: number;
}
export interface BrowserWindowPort {
  control(action: 'show' | 'hide'): Promise<BrowserWindowResult>;
}

/** Visibility policy is separate from task connectivity and window discovery. */
export class BrowserWindowController {
  mode: 'managed' | 'diagnostic' = 'managed';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly port: BrowserWindowPort) {}

  show(): Promise<BrowserWindowResult> {
    return this.schedule(async () => {
      const result = await this.port.control('show');
      if (result.status === 'ok') this.mode = 'diagnostic';
      return result;
    });
  }

  hide(): Promise<BrowserWindowResult> {
    return this.schedule(async () => {
      const result = await this.port.control('hide');
      if (result.status === 'ok') this.mode = 'managed';
      return result;
    });
  }

  hideAutomatically(): Promise<BrowserWindowResult | undefined> {
    return this.schedule(() => this.mode === 'diagnostic' ? Promise.resolve(undefined) : this.port.control('hide'));
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
