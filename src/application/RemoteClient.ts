import type { RemoteJob, RemoteResult } from '../infrastructure/local-bridge/RemoteChannel';
import { banksForPage, parseAccount, parseBanks, parseDescriptor, parseLesson, parseSummary, parseUnits, type Bank, type Descriptor, type Lesson, type ServerAddress, type Unit } from '../domain/remoteProtocol';

export type RemoteFailure = 'not-connected' | 'needs-login' | 'forbidden' | 'network' | 'protocol' | 'server' | 'unsupported';
export class RemoteError extends Error {
  constructor(readonly code: RemoteFailure, readonly detail?: string) { super(code); }
}
export type Transport = (job: RemoteJob, timeoutMs?: number) => Promise<RemoteResult>;

/** Client for protocol idlepage/1. Every request runs in the paired browser on the server's origin. */
export class RemoteClient {
  private descriptor?: Descriptor;
  constructor(private readonly send: Transport, readonly address: ServerAddress) {}
  /** The site's own declared name; never the host, which would expose the address in the UI. */
  get name(): string { return this.descriptor?.name ?? '自定义网站'; }
  async discover(): Promise<Descriptor> {
    if (this.descriptor) return this.descriptor;
    const descriptor = parseDescriptor(await this.json('GET', this.address.home), this.address);
    if (!descriptor) throw new RemoteError('protocol', '服务器没有提供 idlepage/1 描述文件');
    return this.descriptor = descriptor;
  }
  private async study(): Promise<string> {
    const study = (await this.discover()).study;
    if (!study) throw new RemoteError('unsupported', '这个服务器没有练习接口');
    return study;
  }
  private async json(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const result = await this.send({ op: 'fetch', origin: this.address.origin, home: this.address.home, path, method,
      body: body === undefined ? undefined : JSON.stringify(body) }, 30000);
    return parseResponse(result);
  }
  async banks(): Promise<Bank[]> {
    const banks = parseBanks(await this.json('GET', (await this.study()) + 'banks'));
    if (!banks) throw new RemoteError('protocol', '题库清单格式不对');
    return banks;
  }
  /** Banks of the configured practice page. */
  async practiceBanks(): Promise<Bank[]> {
    const banks = banksForPage(await this.banks(), this.address.page);
    if (!banks.length) throw new RemoteError('unsupported', this.address.page ? `${this.address.page} 不是可在插件里练习的页面` : '服务器上没有可练的题库');
    return banks;
  }
  /** Units are optional in the protocol; servers without them practise the whole bank. */
  async units(bank: string, day: string): Promise<Unit[]> {
    const study = await this.study();
    const detail = await this.json('GET', `${study}banks/${encodeURIComponent(bank)}`);
    const progress = await this.json('GET', `${study}banks/${encodeURIComponent(bank)}/progress?day=${day}`).catch(() => undefined);
    return parseUnits(detail, progress);
  }
  async progress(bank: string, day: string): Promise<string | undefined> {
    return parseSummary(await this.json('GET', `${await this.study()}banks/${encodeURIComponent(bank)}/progress?day=${day}`));
  }
  async next(bank: string, request: Record<string, unknown>): Promise<Lesson> {
    const study = await this.study();
    const lesson = parseLesson(await this.json('POST', `${study}banks/${encodeURIComponent(bank)}/next`, { ...request, view: true }), this.address.origin, study);
    if (!lesson) throw new RemoteError('protocol', '取题结果格式不对');
    if (!lesson.questions.length) throw new RemoteError('server', '现在没有可练的题');
    return lesson;
  }
  async results(bank: string, body: Record<string, unknown>): Promise<string | undefined> {
    return parseSummary(await this.json('POST', `${await this.study()}banks/${encodeURIComponent(bank)}/results`, body));
  }
  /** Plays a card's audio on the bank's own player page; media is always played by the site. No player, no sound. */
  async play(src: string, player?: string): Promise<{ played: boolean; reason?: string }> {
    if (!player) return { played: false, reason: 'NoPlayerPage' };
    const result = await this.send({ op: 'play', origin: this.address.origin, home: this.address.home, path: src, player }, 30000);
    if (result.status === 401) throw new RemoteError('needs-login');
    return result.status === 200 && result.played === true ? { played: true } : { played: false, reason: result.error ?? `HTTP ${result.status ?? 0}` };
  }
  async login(): Promise<void> {
    const login = (await this.discover()).login;
    if (!login) throw new RemoteError('unsupported', '服务器没有提供登录地址');
    const result = await this.send({ op: 'login', origin: this.address.origin, path: login });
    if (!result.ok) throw failure(result);
  }
  async loginDone(): Promise<void> { await this.send({ op: 'login-done', origin: this.address.origin }); }
  /** Current account name; throws needs-login when signed out. Without an account endpoint the bank list proves the session. */
  async account(): Promise<string> {
    const path = (await this.discover()).account;
    if (!path) { await this.banks(); return '已登录'; }
    return parseAccount(await this.json('GET', path)) ?? '已登录';
  }
  /** Ends the site's own session (its logout path runs inside the site page), then confirms it. */
  async logout(): Promise<void> {
    const path = (await this.discover()).logout;
    if (!path) throw new RemoteError('unsupported', '服务器没有提供登出地址');
    const result = await this.send({ op: 'fetch', origin: this.address.origin, home: this.address.home, path, method: 'GET' }, 30000);
    if (result.error === 'NotPickedUp' || result.error === 'NotAllowed') throw failure(result);
    try { await this.account(); }
    catch (error) { if (error instanceof RemoteError && error.code === 'needs-login') return; throw error; }
    throw new RemoteError('server', '登出未生效');
  }
}

function failure(result: RemoteResult): RemoteError {
  if (result.error === 'NotPickedUp' || result.error === 'Disposed') return new RemoteError('not-connected');
  if (result.error === 'NotAllowed') return new RemoteError('not-connected', '浏览器扩展尚未获得这个服务器的访问权限');
  return new RemoteError('network', result.error);
}

export function parseResponse(result: RemoteResult): unknown {
  if (result.status === undefined || result.status === 0) throw failure(result);
  let body: unknown;
  try { body = result.text ? JSON.parse(result.text) : undefined; } catch { body = undefined; }
  const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error.slice(0, 200) : undefined;
  if (result.status === 401) throw new RemoteError('needs-login', message);
  if (result.status === 403) throw new RemoteError('forbidden', message);
  if (result.status >= 400) throw new RemoteError('server', message ?? `HTTP ${result.status}`);
  if (body === undefined) throw new RemoteError('protocol', '服务器返回的不是 JSON');
  return body;
}
