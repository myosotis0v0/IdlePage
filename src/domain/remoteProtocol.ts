/**
 * Protocol idlepage/1: what a remote server publishes so IdlePage can use it without
 * site-specific code. Full contract: docs/PLAN.md, "通用服务器协议 idlepage/1".
 * Everything arriving here came from a remote page and is validated before use.
 */
export const PROTOCOL = 'idlepage/1';
export const DESCRIPTOR_PATH = '/.well-known/idlepage.json';

/** `page`: the practice page the user pointed at; only banks declaring that page are offered. */
export interface ServerAddress { origin: string; home: string; page?: string }
export interface Descriptor extends ServerAddress { name: string; login?: string; logout?: string; account?: string; study?: string }
export interface Bank { id: string; title: string; description: string; mode: string; page?: string; player?: string }
export interface Unit { id: string; title: string; group?: string; view: boolean; unlocked?: boolean }
export interface Choice { id: string; label: string; detail?: string }
export interface Grade { rating: number; label: string; hint?: string; again: boolean }
export interface Audio { label: string; src: string }
export type Answer =
  | { type: 'choice'; choices: Choice[]; correct: string; reveal?: string; audio?: string }
  | { type: 'self'; back: string; grades: Grade[]; audio?: string };
export interface View { prompt: string; detail?: string; audio: Audio[]; answer: Answer }
export interface Question { qid: string; view: View }
export interface Lesson { echo: Record<string, string | number | boolean | null>; questions: Question[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
const optional = (value: unknown, max: number): string | undefined => value === undefined || value === null ? undefined : text(value, max);

const pagePath = (path: string) => path.endsWith('/') ? path : path + '/';

/** Accepts a practice page URL (or a site root, or a direct descriptor URL) typed by the user. */
export function serverAddress(input: string): ServerAddress | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) return;
  // Plain HTTP only for this machine; a login cookie must not cross the network in clear text.
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) return;
  if (url.pathname.endsWith('.json')) return { origin: url.origin, home: url.pathname };
  const page = url.pathname === '/' ? undefined : pagePath(url.pathname.replace(/\/index\.html?$/i, '/'));
  return { origin: url.origin, home: DESCRIPTOR_PATH, ...(page ? { page } : {}) };
}

/**
 * Banks belonging to the practice page; every bank when the address is the site itself,
 * or when the server declares no pages at all (page mapping is optional in the protocol).
 */
export function banksForPage(banks: Bank[], page?: string): Bank[] {
  if (!page || !banks.some(bank => bank.page !== undefined)) return banks;
  return banks.filter(bank => bank.page !== undefined && pagePath(bank.page) === page);
}

/** A same-origin absolute path, or undefined. */
export function samePath(origin: string, path: unknown, base = '/'): string | undefined {
  if (typeof path !== 'string' || !path || path.length > 2048 || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
  try {
    const url = new URL(path, origin + base);
    if (url.origin !== origin || url.pathname.split('/').includes('..')) return;
    return url.pathname + url.search;
  } catch { return; }
}

export function parseDescriptor(value: unknown, address: ServerAddress): Descriptor | undefined {
  const r = record(value);
  if (!r || r.protocol !== PROTOCOL) return;
  const paths: Partial<Record<'study' | 'login' | 'logout' | 'account', string>> = {};
  for (const key of ['study', 'login', 'logout', 'account'] as const) {
    if (r[key] === undefined) continue;
    const path = samePath(address.origin, r[key]);
    if (!path) return;
    paths[key] = path;
  }
  const study = paths.study && (paths.study.endsWith('/') ? paths.study : paths.study + '/');
  return { ...address, name: text(r.name, 80) ?? '自定义网站', login: paths.login, logout: paths.logout, account: paths.account, study };
}

/** Display name from the descriptor's account endpoint; servers may use any of these common fields. */
export function parseAccount(value: unknown): string | undefined {
  const r = record(value);
  for (const key of ['display_name', 'name', 'username', 'login']) { const name = r && text(r[key], 80); if (name) return name; }
  return;
}

export function parseBanks(value: unknown): Bank[] | undefined {
  const list = record(value)?.banks;
  if (!Array.isArray(list)) return;
  return list.slice(0, 200).flatMap(item => {
    const r = record(item);
    const id = r && typeof r.id === 'string' && ID.test(r.id) ? r.id : undefined;
    const title = r && text(r.title, 80);
    if (!r || !id || !title || r.view === false) return [];
    const path = (v: unknown) => typeof v === 'string' && /^\/[^/?#][^?#]{0,500}$/.test(v) ? v : undefined;
    const page = path(r.page), player = path(r.player);
    return [{ id, title, description: optional(r.description, 200) ?? '', mode: optional(r.mode, 40) ?? '', ...(page ? { page } : {}), ...(player ? { player } : {}) }];
  });
}

/** Units from GET banks/{id}, merged with unlock state from GET banks/{id}/progress when present. */
export function parseUnits(bank: unknown, progress?: unknown): Unit[] {
  const list = record(bank)?.units;
  const state = record(record(progress)?.units);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).flatMap(item => {
    const r = record(item);
    const id = r && typeof r.id === 'string' && ID.test(r.id) ? r.id : undefined;
    const title = r && text(r.title, 80);
    if (!r || !id || !title) return [];
    const unlocked = record(state?.[id])?.unlocked;
    return [{ id, title, group: optional(r.group, 40), view: r.view !== false, unlocked: typeof unlocked === 'boolean' ? unlocked : undefined }];
  });
}

export function parseSummary(value: unknown): string | undefined { return optional(record(value)?.summary, 200); }

function parseAudio(origin: string, study: string, value: unknown): string | undefined {
  return samePath(origin, value, study);
}

export function parseView(value: unknown, origin: string, study: string): View | undefined {
  const r = record(value), a = record(r?.answer);
  const prompt = r && text(r.prompt, 500);
  if (!r || !a || !prompt) return;
  const audio = Array.isArray(r.audio) ? r.audio.slice(0, 6).flatMap(item => {
    const x = record(item); const src = parseAudio(origin, study, x?.src); const label = text(x?.label, 40);
    return src && label ? [{ label, src }] : [];
  }) : [];
  let answer: Answer | undefined;
  if (a.type === 'choice' && Array.isArray(a.choices)) {
    const choices = a.choices.slice(0, 12).flatMap(item => {
      const x = record(item); const id = typeof x?.id === 'string' && x.id.length <= 120 ? x.id : undefined; const label = text(x?.label, 120);
      return id !== undefined && label ? [{ id, label, detail: optional(x?.detail, 120) }] : [];
    });
    if (choices.length >= 1 && typeof a.correct === 'string' && choices.some(c => c.id === a.correct)) {
      answer = { type: 'choice', choices, correct: a.correct, reveal: optional(a.reveal, 300),
        audio: a.audio === undefined ? undefined : parseAudio(origin, study, a.audio) };
    }
  } else if (a.type === 'self' && Array.isArray(a.grades)) {
    const back = text(a.back, 1000);
    const grades = a.grades.slice(0, 6).flatMap(item => {
      const x = record(item); const label = text(x?.label, 40);
      return x && Number.isSafeInteger(x.rating) && label ? [{ rating: x.rating as number, label, hint: optional(x.hint, 40), again: x.again === true }] : [];
    });
    if (back && grades.length) answer = { type: 'self', back, grades, audio: a.audio === undefined ? undefined : parseAudio(origin, study, a.audio) };
  }
  if (!answer) return;
  return { prompt, detail: optional(r.detail, 200), audio, answer };
}

export function parseLesson(value: unknown, origin: string, study: string): Lesson | undefined {
  const r = record(value);
  if (!r || !Array.isArray(r.questions)) return;
  const echo: Lesson['echo'] = {};
  for (const [key, item] of Object.entries(record(r.lesson) ?? {})) {
    if (/^[a-z_]{1,32}$/.test(key) && !['lesson_id', 'day', 'answers'].includes(key) &&
      (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string' && item.length <= 120)) echo[key] = item;
  }
  const questions = r.questions.slice(0, 200).flatMap(item => {
    const q = record(item);
    const qid = typeof q?.qid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(q.qid) ? q.qid : undefined;
    const view = parseView(q?.view, origin, study);
    return qid && view ? [{ qid, view }] : [];
  });
  return { echo, questions };
}

export function localDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Short name for a configured practice URL: its last path segment (or the host for a site root), at most 18 characters. */
export function siteLabel(url: string): string {
  const short = (text: string) => text.length > 18 ? text.slice(0, 17) + '…' : text;
  try {
    const u = new URL(url);
    return short(u.pathname.split('/').filter(Boolean).pop()?.replace(/\.html?$/i, '') || u.hostname);
  } catch { return short(url); }
}
