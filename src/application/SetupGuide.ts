export class SetupGuide {
  stage: 'offer' | 'opening' | 'install' | 'checking' | 'login' | 'ready' | 'failed' | 'none';
  private deadline = 0;
  private failure = '';
  constructor(completed: boolean) { this.stage = completed ? 'none' : 'offer'; }
  get active() { return ['opening', 'install', 'checking', 'login'].includes(this.stage); }
  start(now = Date.now()) { if (this.active) return false; this.stage = 'opening'; this.deadline = now + 10 * 60_000; return true; }
  opened() { if (this.stage === 'opening') this.stage = 'install'; }
  contact() { if (this.stage !== 'install') return false; this.stage = 'checking'; return true; }
  observe(state: { phase: string; recovery: { waitingLogin: boolean }; failure?: { reason: string } }): boolean {
    if (!['checking', 'login'].includes(this.stage)) return false;
    if (state.phase === 'bookshelf-page-ready') { this.stage = 'ready'; return true; }
    if (state.phase === 'bookshelf-candidates-ready') this.fail('未能确认书架，请显示浏览器检查后重新设置');
    else if (state.phase === 'task-failed' || state.phase === 'cancelled') this.fail(state.failure?.reason === 'access-blocked' ? '访问受阻，请显示浏览器检查后重新设置' : '连接验证未完成，请显示浏览器检查后重新设置');
    else this.stage = state.recovery.waitingLogin ? 'login' : 'checking';
    return false;
  }
  expire(now = Date.now()) { if (!this.active || now < this.deadline) return false; this.fail('设置等待超时，请悬停重新开始'); return true; }
  fail(message: string) { this.stage = 'failed'; this.failure = message; }
  dismiss() { this.stage = 'none'; }
  view() {
    const steps = {
      offer: ['首次使用：悬停开始连接', '点击“首次连接设置”，自动打开专用 Edge 并复制本机扩展目录。'],
      opening: ['设置 1/3：正在打开 Edge', '正在准备专用浏览器和本机配对目录，请稍候。'],
      install: ['设置 1/3：在 Edge 加载扩展', '在已打开的 Edge 扩展页：开启开发人员模式 → 加载解压缩的扩展 → Ctrl+V 粘贴已复制的目录并选择。安装后自动进入下一步，无需点击验证。'],
      checking: ['设置 2/3：正在连接并读取书架', '浏览器扩展已连接，正在自动访问起点和获取书架。若需要登录，会自动显示浏览器。'],
      login: ['设置 2/3：请在 Edge 登录起点', '请在专用 Edge 的官方页面手动登录。登录确认后会自动读取书架，无需手动打开页面或返回点击继续。'],
      ready: ['设置 3/3：已就绪，悬停进入书架', '连接和书架获取已完成。点击“进入书架” → 选择书籍 → 选择章节，即可阅读。'],
      failed: ['连接设置已停止', this.failure],
      none: ['', ''],
    };
    const [text, detail] = steps[this.stage]; return { text, detail, active: this.active };
  }
}
