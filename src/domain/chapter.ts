export const chapterFailureReasons = ['locked', 'needs-login', 'access-blocked', 'page-error', 'content-not-found', 'unsupported-content', 'timeout'] as const;
export type ChapterFailureReason = typeof chapterFailureReasons[number];
export type ChapterBatch = { status: 'available'; offset: number; total: number; text: string } | { status: 'unavailable'; reason: ChapterFailureReason };
export type ChapterResult = { status: 'available'; title: string; text: string } | { status: 'unavailable'; reason: ChapterFailureReason };
export function parseChapterBatch(value: unknown): ChapterBatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  if (r.status === 'unavailable' && Object.keys(r).every(k => ['status', 'reason'].includes(k)) && chapterFailureReasons.includes(r.reason as ChapterFailureReason)) return r as ChapterBatch;
  if (r.status !== 'available' || Object.keys(r).some(k => !['status', 'offset', 'total', 'text'].includes(k)) ||
      !Number.isSafeInteger(r.offset) || (r.offset as number) < 0 || !Number.isSafeInteger(r.total) || (r.total as number) < 1 || (r.total as number) > 500000 ||
      typeof r.text !== 'string' || !r.text.length || r.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.text) || (r.offset as number) + r.text.length > (r.total as number)) return;
  return r as ChapterBatch;
}
