export type AccessState = 'SiteContentVisible' | 'NeedsLogin' | 'AccessBlocked' | 'Indeterminate';
export type PageKind = 'other' | 'login' | 'bookshelf' | 'book' | 'chapter';
export interface Observation {
  state: AccessState;
  pageKind: PageKind;
  bodyCharacters: number;
  bookLinks: number;
  verification: boolean;
  tooFrequent: boolean;
  captchaFrame: boolean;
  loginEvidence?: 'bookshelf-content' | 'signed-in-control';
}
export interface BrowserTask {
  id: string;
  kind: 'access' | 'bookshelf' | 'bookshelf-list' | 'catalog' | 'chapter' | 'login';
  url: string;
  bookId?: string;
  purpose?: 'prefetch' | 'reading';
}
export interface AccessReport extends Observation {
  observedAt: string;
  taskKind: BrowserTask['kind'];
}
export function parseObservation(value: unknown): Observation | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  const keys = ['state', 'pageKind', 'bodyCharacters', 'bookLinks', 'verification', 'tooFrequent', 'captchaFrame', 'loginEvidence'];
  if (Object.keys(r).some(key => !keys.includes(key))) return;
  if (!['SiteContentVisible', 'NeedsLogin', 'AccessBlocked', 'Indeterminate'].includes(r.state as string) ||
      !['other', 'login', 'bookshelf', 'book', 'chapter'].includes(r.pageKind as string) ||
      !['bodyCharacters', 'bookLinks'].every(key => typeof r[key] === 'number' && Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] < 100000000) ||
      !['verification', 'tooFrequent', 'captchaFrame'].every(key => typeof r[key] === 'boolean')) return;
  const result = { ...r } as unknown as Observation;
  if (r.loginEvidence !== undefined && (!['bookshelf-content', 'signed-in-control'].includes(r.loginEvidence as string) || r.pageKind !== 'bookshelf')) return;
  if (result.verification || result.tooFrequent || result.captchaFrame) result.state = 'AccessBlocked';
  else if (result.pageKind === 'login') result.state = 'NeedsLogin';
  else if (result.loginEvidence && result.state !== 'NeedsLogin') result.state = 'SiteContentVisible';
  else if (result.state === 'SiteContentVisible' && (result.bodyCharacters <= 500 || result.bookLinks === 0 && !['book', 'chapter'].includes(result.pageKind))) result.state = 'Indeterminate';
  return result;
}
