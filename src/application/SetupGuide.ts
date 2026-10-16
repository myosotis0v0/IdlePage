/**
 * First use only installs and connects the browser companion. Site logins are lazy:
 * Qidian login is requested when the bookshelf is first opened, a practice site's login
 * when practice first needs it.
 */
export class SetupGuide {
  stage: 'offer' | 'opening' | 'install' | 'ready' | 'failed' | 'none';
  private deadline = 0;
  private failure = '';
  constructor(completed: boolean) { this.stage = completed ? 'none' : 'offer'; }
  get active() { return ['opening', 'install'].includes(this.stage); }
  start(now = Date.now()) { if (this.active) return false; this.stage = 'opening'; this.deadline = now + 10 * 60_000; return true; }
  opened() { if (this.stage === 'opening') this.stage = 'install'; }
  /** First authenticated contact of the paired companion completes setup. */
  contact() { if (this.stage !== 'install') return false; this.stage = 'ready'; return true; }
  expire(now = Date.now()) { if (!this.active || now < this.deadline) return false; this.fail('设置等待超时，请悬停重新开始'); return true; }
  fail(message: string) { this.stage = 'failed'; this.failure = message; }
  dismiss() { this.stage = 'none'; }
  view() {
    const steps = {
      offer: ['首次使用：悬停开始连接', '点击“首次连接设置”，自动启动专用 Edge 并加载配套扩展，无需手动安装。'],
      opening: ['设置 1/2：正在启动 Edge', '正在准备专用浏览器和本机配对目录，请稍候。'],
      install: ['设置 1/2：正在连接扩展', '专用 Edge 已启动并自动加载配套扩展，连上后自动完成，无需任何操作。'],
      ready: ['设置 2/2：已连接', '浏览器扩展已连接。阅读：点“进入书架”，首次会请你在 Edge 登录起点；练习：在“自定义连接”里点“练习”。'],
      failed: ['连接设置已停止', this.failure],
      none: ['', ''],
    };
    const [text, detail] = steps[this.stage]; return { text, detail, active: this.active };
  }
}
