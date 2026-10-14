export interface Bookmark {
  bookId: string;
  chapterId: string;
  title: string;
  offset: number;
  progress: number;
}
interface Storage { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
const key = 'idlepage.readingProgress.v1';
function valid(value: unknown): value is Bookmark {
  if (!value || typeof value !== 'object') return false;
  const b = value as Bookmark;
  return typeof b.bookId === 'string' && typeof b.chapterId === 'string' && /^\d{1,20}$/.test(b.bookId) && /^[a-zA-Z0-9_-]{1,80}$/.test(b.chapterId) && typeof b.title === 'string' && b.title.length <= 300 &&
    Number.isSafeInteger(b.offset) && b.offset >= 0 && Number.isFinite(b.progress) && b.progress >= 0 && b.progress <= 100;
}
/** Position metadata is independent of chapter LRU eviction. Never sync account data. */
export class ReadingProgress {
  private books = new Map<string, Bookmark>();
  private lastBook?: string;
  private queue = Promise.resolve();
  constructor(private storage: Storage, private failed: () => void) {
    const saved = storage.get<{ books?: unknown[]; lastBook?: string }>(key);
    if (Array.isArray(saved?.books)) for (const b of saved.books.slice(-300)) if (valid(b)) this.books.set(b.bookId, { ...b });
    if (saved?.lastBook && this.books.has(saved.lastBook)) this.lastBook = saved.lastBook;
  }
  get(bookId: string) { const b = this.books.get(bookId); return b ? { ...b } : undefined; }
  last() { return this.lastBook ? this.get(this.lastBook) : undefined; }
  save(bookmark: Bookmark) {
    if (!valid(bookmark)) return;
    if (this.lastBook === bookmark.bookId && JSON.stringify(this.books.get(bookmark.bookId)) === JSON.stringify(bookmark)) return;
    this.books.delete(bookmark.bookId); this.books.set(bookmark.bookId, { ...bookmark }); this.lastBook = bookmark.bookId;
    while (this.books.size > 300) this.books.delete(this.books.keys().next().value!);
    const snapshot = { books: [...this.books.values()], lastBook: this.lastBook };
    this.queue = this.queue.then(() => this.storage.update(key, snapshot)).catch(() => this.failed());
  }
  flush() { return this.queue; }
}
