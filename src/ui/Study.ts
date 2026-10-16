import * as vscode from 'vscode';
import { RemoteClient, RemoteError } from '../application/RemoteClient';
import { StudySession } from '../application/StudySession';
import { localDay, serverAddress, siteLabel, type Bank } from '../domain/remoteProtocol';

/** One configured practice page: the URL the user entered and its protocol client. */
export interface Site { url: string; client: RemoteClient }
export interface StudyHost {
  /** Configured practice pages, in the user's order. */
  sites(): Site[];
  /** Replaces the configured list (add / edit / remove). */
  saveSites(urls: string[]): Promise<boolean>;
  /** Starts the dedicated browser if needed and waits for the companion's remote channel. */
  ensureBrowser(): Promise<boolean>;
  revealBrowser(): Promise<void>;
  hideBrowser(): void;
  /** Login state or practice mode changed: the book hover menu shows them. */
  changed(): void;
}
export interface CustomSiteState { sites: Array<{ url: string; label: string; account?: string; active: boolean }>; practicing: boolean }
/** How a configured URL is shown: without the scheme or a trailing slash. */
const MAX_SITES = 6;   // each site's origin becomes a host permission of the companion (pairing lists at most 8 origins)
type Mode = 'idle' | 'busy' | 'login' | 'error' | 'session' | 'summary';
const failures: Record<string, string> = {
  'not-connected': '未连接到专用浏览器扩展。如尚未安装，请先在书本菜单完成首次连接设置',
  'needs-login': '需要登录', forbidden: '当前账号没有权限', network: '无法访问服务器',
  protocol: '服务器不符合 idlepage/1 协议', server: '服务器返回错误', unsupported: '服务器不支持练习',
};
const playFailures: Record<string, string> = {
  NoPlayerFunction: '网站播放器页没有加载出来', PlayerDeclined: '网站播放器放不了：浏览器不准出声或没有可用的音源/语音',
  'not-connected': '专用浏览器未连接', NoResult: '播放器页没有响应',
};
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + '…' : value;
interface Slot { text: string; command?: string | vscode.Command; tooltip?: string; color?: vscode.ThemeColor }
const passed = new vscode.ThemeColor('testing.iconPassed'), failed = new vscode.ThemeColor('testing.iconFailed');
// Step-grid rhythm labels ("●○○○ ●○●○"). In the status-bar font (Segoe UI) ● is 7.25px and ○ 10.34px wide, and
// codicons get padding that spreads 16 cells far apart; ◆/◇ are both 7.2px and stay compact. One space between beats.
const glyphs = (label: string) => /[●○]/.test(label)
  ? label.trim().split(/\s+/).map(beat => beat.replace(/●/g, '◆').replace(/○/g, '◇')).join(' ')
  : label;
const mark = (i: number) => '①②③④⑤⑥⑦⑧⑨⑩⑪⑫'[i] ?? String(i + 1);
const key = (i: number) => i < 9 ? `Alt+${i + 1}` : '';

/** Practice cards from any idlepage/1 server, laid out as a row of native status-bar items. */
export class StudyController implements vscode.Disposable {
  private slots: vscode.StatusBarItem[] = [];
  private mode: Mode = 'idle';
  private message = '';
  private session?: StudySession;
  private bank?: { id: string; title: string; player?: string; request: Record<string, unknown> };
  private retry?: () => Promise<void>;
  private epoch = 0;
  /** The practice page in use. */
  private site?: Site;
  /** Signed-in account per site origin, known only after a request proved the session (lazy: nothing is checked at startup). */
  private accounts = new Map<string, string>();
  private get account(): string | undefined { return this.site && this.accounts.get(this.site.client.address.origin); }
  private set account(name: string | undefined) {
    if (!this.site) return;
    const origin = this.site.client.address.origin;
    if (name === undefined) this.accounts.delete(origin); else this.accounts.set(origin, name);
  }
  /** Result of the last choice answered, shown as one mark at the right end of the row. */
  private last?: 'right' | 'wrong';
  private disposables: vscode.Disposable[] = [];
  constructor(private readonly host: StudyHost) {
    this.disposables.push(
      vscode.commands.registerCommand('idlepage.study.open', (url: unknown) => this.open(url)),
      vscode.commands.registerCommand('idlepage.study.setServer', (url: unknown) => this.editSite(url)),
      vscode.commands.registerCommand('idlepage.study.addSite', () => this.addSite()),
      vscode.commands.registerCommand('idlepage.study.removeSite', (url: unknown) => this.removeSite(url)),
      vscode.commands.registerCommand('idlepage.study.primary', () => this.primary()),
      vscode.commands.registerCommand('idlepage.study.option', (n: unknown) => this.option(n)),
      vscode.commands.registerCommand('idlepage.study.replay', (n: unknown) => this.replay(n === 'after' ? n : typeof n === 'number' ? n : 0)),
      vscode.commands.registerCommand('idlepage.study.again', () => this.bank ? this.run(() => this.start()) : this.open(this.site?.url)),
      vscode.commands.registerCommand('idlepage.study.stop', () => this.stop()),
      vscode.commands.registerCommand('idlepage.study.login', (url: unknown) => this.signIn(url)),
      vscode.commands.registerCommand('idlepage.study.logout', (url: unknown) => this.signOut(url)),
    );
  }
  /** The configured list changed: forget removed sites; a practice on a removed page ends. */
  serverChanged() {
    const sites = this.host.sites();
    const origins = new Set(sites.map(s => s.client.address.origin));
    for (const origin of [...this.accounts.keys()]) if (!origins.has(origin)) this.accounts.delete(origin);
    const current = this.site && sites.find(s => s.url === this.site!.url);
    if (this.site && !current) { this.epoch++; this.session = undefined; this.bank = undefined; this.site = undefined; this.set('idle'); return; }
    if (current) this.site = current;   // fresh client object for the same URL
    this.host.changed();
  }
  state(): CustomSiteState {
    return { practicing: this.mode !== 'idle', sites: this.host.sites().map(s => ({ url: s.url, label: siteLabel(s.url),
      account: this.accounts.get(s.client.address.origin), active: this.mode !== 'idle' && this.site?.url === s.url })) };
  }
  /**
   * Makes `url` (or the only / a picked configured page) the page in use. Switching pages ends a
   * running practice on the other page first (its answers are submitted, as with 结束练习).
   */
  private async choose(url: unknown, purpose: string): Promise<boolean> {
    let sites = this.host.sites();
    if (!sites.length) { if (!await this.addSite()) return false; sites = this.host.sites(); }
    let site = typeof url === 'string' ? sites.find(s => s.url === url) : sites.length === 1 ? sites[0] : undefined;
    if (!site && typeof url !== 'string') {
      const picked = await vscode.window.showQuickPick(sites.map(s => ({ label: siteLabel(s.url), description: s.url, detail: this.accounts.get(s.client.address.origin), site: s })),
        { title: `余页 · ${purpose}`, placeHolder: '选择练习网址' });
      site = picked?.site;
    }
    if (!site) return false;
    if (this.site?.url !== site.url && this.mode !== 'idle') await this.stop();
    this.site = site;
    return true;
  }
  private async signIn(url?: unknown) {
    if (!await this.choose(url, '登录')) return;
    await this.run(async () => {
      this.set('busy', '正在确认登录…');
      this.account = await this.client().account();
      this.set(this.session ? 'session' : 'idle');
      vscode.window.setStatusBarMessage(`余页：已登录 ${this.client().name} · ${this.account}`, 8000);
    });
  }
  private async signOut(url?: unknown) {
    if (!await this.choose(url, '登出')) return;
    if (this.mode !== 'idle') await this.stop();
    await this.run(async () => {
      this.set('busy', '正在登出…');
      await this.client().logout();
      this.account = undefined; this.set('idle');
      vscode.window.setStatusBarMessage(`余页：已登出 ${this.client().name}`, 8000);
    });
  }
  private set(mode: Mode, message = '') {
    this.mode = mode; this.message = message;
    void vscode.commands.executeCommand('setContext', 'idlepage.studying', mode !== 'idle');
    this.render(); this.host.changed();
  }
  private async askUrl(title: string, value: string, others: string[]): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({ title, value: value || 'https://',
      prompt: '输入支持 idlepage/1 协议的网站上某个练习页的地址，例如 https://example.com/tools/music/ear-training/',
      validateInput: text => !serverAddress(text) ? '请输入 https 网址（本机调试可用 http://127.0.0.1）'
        : others.includes(text.trim()) ? '这个网址已经在列表里了' : undefined });
    return input?.trim();
  }
  private async addSite(): Promise<boolean> {
    const urls = this.host.sites().map(s => s.url);
    if (urls.length >= MAX_SITES) { void vscode.window.showWarningMessage(`余页：最多保存 ${MAX_SITES} 个练习网址，请先删除不用的。`); return false; }
    const url = await this.askUrl('余页 · 添加练习网址', '', urls);
    if (!url) return false;
    return this.host.saveSites([...urls, url]);
  }
  private async editSite(url?: unknown) {
    const urls = this.host.sites().map(s => s.url);
    if (typeof url !== 'string' || !urls.includes(url)) { await this.addSite(); return; }
    const next = await this.askUrl('余页 · 修改练习网址', url, urls.filter(u => u !== url));
    if (next && next !== url) await this.host.saveSites(urls.map(u => u === url ? next : u));
  }
  private async removeSite(url?: unknown) {
    const urls = this.host.sites().map(s => s.url);
    if (typeof url !== 'string' || !urls.includes(url)) return;
    const ok = await vscode.window.showWarningMessage(`从列表中删除 ${url}？`, { modal: true, detail: '只删除这条网址，不影响网站上的练习进度。' }, '删除');
    if (ok === '删除') await this.host.saveSites(urls.filter(u => u !== url));
  }
  private async open(url?: unknown) {
    if (!await this.choose(url, '练习')) return;
    await this.run(async () => {
      const client = this.client();
      this.set('busy', `正在连接 ${client.name}…`);
      const banks = await client.practiceBanks();
      if (!this.account) this.account = await client.account().catch(() => undefined);
      const bank = banks.length === 1 ? banks[0] : await this.pick(banks, client.name);
      if (!bank) { this.set(this.session ? 'session' : 'idle'); return; }
      const request: Record<string, unknown> = {};
      const units = (await client.units(bank.id, localDay())).filter(u => u.view);
      if (units.length) {
        type UnitItem = vscode.QuickPickItem & { unit?: string };
        const items: UnitItem[] = [{ label: '$(shuffle) 混合练习', description: '在已解锁的单元里按掌握程度抽题' }];
        for (const u of units.filter(u => u.unlocked !== false)) items.push({ label: u.title, description: u.group, unit: u.id });
        const picked = await vscode.window.showQuickPick(items, { title: `${bank.title} · 选择单元`, placeHolder: '选择要练习的单元' });
        if (!picked) { this.set(this.session ? 'session' : 'idle'); return; }
        if (picked.unit) request.unit = picked.unit;
      }
      this.bank = { id: bank.id, title: bank.title, player: bank.player, request };
      await this.start();
    });
  }
  private async pick(banks: Bank[], server: string): Promise<Bank | undefined> {
    const picked = await vscode.window.showQuickPick(banks.map(bank => ({ label: bank.title, description: bank.description, bank })),
      { title: `余页 · 练习 · ${server}`, placeHolder: '选择题库', matchOnDescription: true });
    return picked?.bank;
  }
  private client(): RemoteClient {
    if (!this.site) throw new RemoteError('unsupported', '尚未选择练习网址');
    return this.site.client;
  }
  private async start() {
    const bank = this.bank!; const epoch = this.epoch;
    this.set('busy', `正在取题 · ${bank.title}`);
    const lesson = await this.client().next(bank.id, { ...bank.request, day: localDay() });
    if (epoch !== this.epoch) return;
    this.session = new StudySession(bank.id, bank.title, lesson); this.last = undefined;
    this.set('session'); this.autoplay();
  }
  /** Runs a remote operation; recovers browser connection and login once, then stops on failure. */
  private async run(action: () => Promise<void>, attempt = 0): Promise<void> {
    const epoch = this.epoch;
    try { await action(); }
    catch (error) {
      if (epoch !== this.epoch) return;
      const e = error instanceof RemoteError ? error : new RemoteError('network');
      if (e.code === 'needs-login') this.account = undefined;
      if (e.code === 'not-connected' && attempt === 0) {
        this.set('busy', '正在连接专用浏览器…');
        if (await this.host.ensureBrowser() && epoch === this.epoch) return this.run(action, 1);
      }
      if (e.code === 'needs-login' && attempt < 2 && await this.login(epoch)) return this.run(action, 2);
      if (epoch !== this.epoch) return;
      const message = e.code === 'server' && e.detail ? e.detail : failures[e.code] + (e.detail && e.code !== 'server' ? `：${e.detail}` : '');
      this.retry = () => this.run(action);
      this.set('error', message);
      void vscode.window.showWarningMessage(`余页练习：${message}`);
    }
  }
  private async login(epoch: number): Promise<boolean> {
    const client = this.client();
    this.set('login', `请在专用浏览器中登录 ${client.name}，完成后自动继续`);
    try { await client.login(); } catch { return false; }
    await this.host.revealBrowser().catch(() => {});
    const deadline = Date.now() + 5 * 60000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (epoch !== this.epoch) return false;
      try { await client.banks(); }
      catch (error) { if (error instanceof RemoteError && error.code === 'needs-login') continue; return false; }
      await client.loginDone().catch(() => {});
      this.account = await client.account().catch(() => '已登录');
      this.host.hideBrowser();
      return epoch === this.epoch;
    }
    return false;
  }
  private async primary() {
    const s = this.session;
    if (this.mode === 'error') { const retry = this.retry; this.retry = undefined; if (retry) await retry(); return; }
    if (this.mode === 'summary') return vscode.commands.executeCommand('idlepage.study.again');
    if (this.mode === 'idle') return this.open();
    if (this.mode !== 'session' || !s) return;
    if (s.phase === 'answered') { s.advance(); return this.afterStep(); }
    const answer = s.current?.view.answer;
    if (s.phase === 'front' && answer?.type === 'self') { this.reveal(s); return; }
    // Choice card, or a revealed self card: pick from the native list.
    const options = s.phase === 'front' && answer?.type === 'choice' ? answer.choices.map((c, i) => ({ label: `${i + 1}. ${c.label}`, description: c.detail, index: i + 1 }))
      : answer?.type === 'self' ? answer.grades.map((g, i) => ({ label: `${i + 1}. ${g.label}`, description: g.hint, index: i + 1 })) : [];
    const picked = await vscode.window.showQuickPick(options, { title: clip(s.current!.view.prompt, 80), placeHolder: answer?.type === 'self' ? '给自己打分' : '选择答案' });
    if (picked && this.session === s) await this.option(picked.index);
  }
  private async option(n: unknown) {
    const s = this.session;
    if (this.mode !== 'session' || !s?.current) return;
    const answer = s.current.view.answer;
    if (answer.type === 'choice') {
      // A wrong answer is showing its correction: any option (or Alt+.) continues.
      if (s.phase === 'answered') { s.advance(); return this.afterStep(); }
      const choice = typeof n === 'number' ? answer.choices[n - 1] : answer.choices.find(c => c.id === n);
      if (!choice || !s.choose(choice.id)) return;
      this.last = s.choice!.correct ? 'right' : 'wrong';
      // Right: straight to the next card. Wrong: stay, mark the correct option, play the resolution.
      if (this.last === 'right') { s.advance(); return this.afterStep(); }
      this.render();
      if (answer.audio) void this.play(answer.audio);
    } else {
      if (s.phase === 'front') { this.reveal(s); return; }
      const grade = typeof n === 'number' ? answer.grades[n - 1] : undefined;
      if (!grade || !s.grade(grade.rating)) return;
      await this.afterStep();
    }
  }
  /** Flip a self card; its answer audio (e.g. the reading of a word shown in Chinese) plays now. */
  private reveal(s: StudySession) {
    if (!s.reveal()) return;
    this.render();
    const answer = s.current?.view.answer;
    if (answer?.type === 'self' && answer.audio) void this.play(answer.audio);
  }
  private async afterStep() {
    const s = this.session!;
    if (s.phase !== 'finished') { this.render(); this.autoplay(); return; }
    await this.submit(s);
  }
  private async submit(s: StudySession) {
    const body = s.submission(localDay());
    if (!body) { this.set('summary', '本组没有作答'); return; }
    await this.run(async () => {
      this.set('busy', '正在交卷…');
      const summary = await this.client().results(s.bank, body);
      if (this.session !== s) return;
      const score = s.score;
      this.set('summary', summary ?? (score.answered ? `答对 ${score.correct}/${score.answered}` : `完成 ${s.answers.length} 张`));
    });
  }
  private autoplay() {
    const audio = this.session?.current?.view.audio[0];
    if (audio && this.session?.phase === 'front') void this.play(audio.src);
  }
  private async replay(which: number | 'after') {
    const view = this.session?.current?.view;
    // Alt+, on a flipped card shown in Chinese replays its reading (its only audio is the answer's).
    const src = which === 'after' ? view?.answer.audio : view?.audio[which]?.src ?? (view?.answer.type === 'self' && this.session?.phase === 'revealed' ? view.answer.audio : undefined);
    if (src) await this.play(src);
  }
  private async play(src: string) {
    if (!this.bank?.player) return; // the site plays its own media; without a player page there is no sound
    let reason: string | undefined;
    try { const result = await this.client().play(src, this.bank?.player); if (!result.played) reason = result.reason; }
    catch (error) { reason = error instanceof RemoteError ? error.code + (error.detail ? `: ${error.detail}` : '') : 'Failed'; }
    if (reason) vscode.window.setStatusBarMessage(`余页练习：声音未能播放（${playFailures[reason] ?? reason}）`, 8000);
  }
  private async stop() {
    const s = this.session; this.epoch++;
    this.session = undefined; this.retry = undefined;
    // Leaving mid-lesson still records what was answered, as on the site itself.
    const body = s && s.phase !== 'finished' ? s.submission(localDay()) : undefined;
    this.set('idle');
    if (s && body) await this.client().results(s.bank, body).catch(() => {
      void vscode.window.showWarningMessage('余页练习：已答部分未能提交。');
    });
  }
  /**
   * Everything is laid out directly in the status bar, like reading: card text, each choice or
   * grade as its own clickable item, feedback and next. Tooltips only repeat clipped text.
   */
  private render() {
    const row: Slot[] = [];
    const add = (text: string, command?: string | vscode.Command, tooltip?: string, color?: vscode.ThemeColor) => row.push({ text, command, tooltip, color });
    const cmd = (command: string, ...args: unknown[]): vscode.Command => ({ command, title: '', arguments: args });
    const s = this.session;
    if (this.mode === 'idle') { /* nothing shown */ }
    else if (this.mode !== 'session' || !s?.current) {
      if (this.mode === 'busy') add(`$(sync~spin) ${clip(this.message, 40)}`, undefined, this.message);
      if (this.mode === 'login') { add(`$(account) ${clip(this.message, 40)}`, undefined, this.message); add('$(eye) 显示浏览器', 'idlepage.showBrowser'); }
      if (this.mode === 'error') { add(`$(warning) ${clip(this.message, 40)}`, undefined, this.message); add('$(refresh) 重试', 'idlepage.study.primary'); add('$(eye) 显示浏览器', 'idlepage.showBrowser'); }
      if (this.mode === 'summary') {
        add(`$(check) ${this.bank ? clip(this.bank.title, 12) + ' · ' : ''}${clip(this.message, 50)}`, undefined, this.message);
        add('$(debug-restart) 再来一组', 'idlepage.study.again'); add('$(list-selection) 换', 'idlepage.study.open');
      }
      add('$(close)', 'idlepage.study.stop', '结束练习');
    } else {
      const q = s.current, answer = q.view.answer;
      add(`$(mortar-board) ${s.index}/${s.total}`, 'idlepage.study.open', this.bank ? `${this.bank.title} · 点击重新选择` : undefined);
      const replay = q.view.audio.length ? cmd('idlepage.study.replay', 0) : undefined;
      // A wrong answer keeps the card in place and marks the correct option; a right one never lands here.
      const wrong = s.phase === 'answered' && answer.type === 'choice' && s.choice && !s.choice.correct ? s.choice.picked : undefined;
      if (s.phase === 'revealed' && answer.type === 'self') {
        add(clip(`${q.view.prompt} → ${answer.back}`, 60), undefined, `${q.view.prompt}\n${answer.back}`);
        answer.grades.forEach((g, i) => add(`${mark(i)} ${g.label}${g.hint ? '·' + g.hint : ''}`, cmd('idlepage.study.option', i + 1), key(i)));
        if (answer.audio && !q.view.audio.length) add('$(unmute)', cmd('idlepage.study.replay', 'after'), '再听一遍 · Alt+,');
      } else {
        add(clip(q.view.prompt + (q.view.detail ? ` · ${q.view.detail}` : ''), 40), replay ?? (answer.type === 'self' ? 'idlepage.study.primary' : undefined),
          q.view.prompt + (replay ? '\n点击再听一遍' : ''));
        // Circled marks keep the choice number apart from digits inside labels ("2/4");
        // a short detail ("do", "P5") is shown inline, a long one only in the tooltip.
        if (answer.type === 'choice') answer.choices.forEach((c, i) => {
          const fix = wrong === undefined ? '' : c.id === answer.correct ? '$(check) ' : c.id === wrong ? '$(close) ' : '';
          add(`${fix}${mark(i)} ${glyphs(clip(c.label, 20))}${c.detail && c.detail.length <= 4 ? '·' + c.detail : ''}`,
            cmd('idlepage.study.option', i + 1), [c.label, c.detail, wrong === undefined ? key(i) : '点任一选项继续'].filter(Boolean).join(' · '),
            wrong !== undefined && c.id === answer.correct ? passed : undefined);
        });
        else add('$(eye) 翻开', 'idlepage.study.primary', 'Alt+.');
      }
      if (q.view.audio.length) add('$(unmute)', replay, q.view.audio.map(a => a.label).join(' / ') + ' · Alt+,');
      // Only right / wrong, at the right end; details live in the tooltip.
      if (this.last) {
        const correct = answer.type === 'choice' ? answer.choices.find(c => c.id === answer.correct) : undefined;
        add(this.last === 'right' ? '$(pass)' : '$(error)', wrong !== undefined ? 'idlepage.study.primary' : undefined,
          wrong !== undefined ? [`正确：${correct?.label ?? ''}`, answer.type === 'choice' ? answer.reveal : undefined, '点任一选项或 Alt+. 继续'].filter(Boolean).join('\n') : this.last === 'right' ? '上一题答对了' : '上一题答错了',
          this.last === 'right' ? passed : failed);
      }
      add('$(close)', 'idlepage.study.stop', '结束练习（已答部分会提交）');
    }
    this.layout(row);
  }
  /** Visible practice items, left to right (diagnostics and host tests). */
  row(): Array<{ text: string; command?: string }> {
    return this.visible.map(slot => ({ text: slot.text, command: typeof slot.command === 'string' ? slot.command : slot.command?.command }));
  }
  private visible: Slot[] = [];
  /** Fixed left-side IDs (VS Code restores alignment by ID), placed between the book icon and the reader. */
  private layout(row: Slot[]) {
    this.visible = row;
    while (this.slots.length < row.length) {
      const i = this.slots.length;
      const item = vscode.window.createStatusBarItem(`idlepage.study.slot${i}.left`, vscode.StatusBarAlignment.Left, -0.1 - i * 0.01);
      item.name = '余页练习'; this.slots.push(item);
    }
    this.slots.forEach((item, i) => {
      const slot = row[i];
      if (!slot) { item.hide(); return; }
      item.text = slot.text; item.command = slot.command; item.tooltip = slot.tooltip; item.color = slot.color; item.show();
    });
  }
  dispose() { this.epoch++; for (const item of this.slots) item.dispose(); for (const d of this.disposables) d.dispose(); }
}
