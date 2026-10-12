export type AccessState = 'SiteContentVisible' | 'NeedsLogin' | 'AccessBlocked' | 'Indeterminate';
export type PageKind = 'other' | 'login' | 'bookshelf';
export interface Observation {
  state: AccessState;
  pageKind: PageKind;
  bodyCharacters: number;
  bookLinks: number;
  verification: boolean;
  tooFrequent: boolean;
  captchaFrame: boolean;
}
export interface BrowserTask {
  id: string;
  kind: 'access' | 'bookshelf';
  url: string;
}
export interface AccessReport extends Observation {
  observedAt: string;
  taskKind: BrowserTask['kind'];
}
export function parseObservation(value: unknown): Observation | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  const keys = ['state', 'pageKind', 'bodyCharacters', 'bookLinks', 'verification', 'tooFrequent', 'captchaFrame'];
  if (Object.keys(r).some(key => !keys.includes(key))) return;
  if (!['SiteContentVisible', 'NeedsLogin', 'AccessBlocked', 'Indeterminate'].includes(r.state as string) ||
      !['other', 'login', 'bookshelf'].includes(r.pageKind as string) ||
      !['bodyCharacters', 'bookLinks'].every(key => typeof r[key] === 'number' && Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] < 100000000) ||
      !['verification', 'tooFrequent', 'captchaFrame'].every(key => typeof r[key] === 'boolean')) return;
  const result = { ...r } as unknown as Observation;
  if (result.verification || result.tooFrequent || result.captchaFrame) result.state = 'AccessBlocked';
  else if (result.pageKind === 'login') result.state = 'NeedsLogin';
  else if (result.state === 'SiteContentVisible' && (result.bodyCharacters <= 500 || result.bookLinks === 0)) result.state = 'Indeterminate';
  return result;
}
