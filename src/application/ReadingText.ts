/** Width estimates: native status items do not expose font metrics. */
export function textCells(character: string): number {
  if (character === '\u200b') return 0;
  if (/^[\r\n\t]+$/.test(character)) return character.length * 0.75;
  if (/\p{Extended_Pictographic}/u.test(character)) return 1.5;
  return /^[\u0000-\u007f]$/.test(character) && !/[MW@%#&]/.test(character) ? 0.75 : 1;
}
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const closing = /^[”’」』）】"')\]]$/u;
const opening = /^[“‘「『（【"'(\[]$/u;
const word = /^[\p{Script=Latin}\p{N}]+$/u;
interface Candidate { end: number; cost: number; quality: number }

/** Immutable chapter index; semantic boundaries and prefix widths are built once. */
class Chapter {
  readonly points: string[];
  readonly offsets: number[];
  private widths = [0];
  private boundaries: number[];
  constructor(readonly text: string) {
    const parts = Array.from(segmenter.segment(text));
    this.points = parts.map(part => part.segment);
    this.offsets = [...parts.map(part => part.index), text.length];
    for (const point of this.points) this.widths.push(this.widths.at(-1)! + textCells(point));
    this.boundaries = this.points.map((_, i) => this.boundary(i + 1));
  }
  width(start: number, end: number) { return this.widths[end] - this.widths[start]; }
  private boundary(end: number): number {
    if (end === this.points.length) return 0;
    const next = this.points[end], previous = this.points[end - 1];
    if (closing.test(next) || opening.test(previous) || /[，。；！？、：,.;!?:]/u.test(next)) return 40;
    if (previous === next && /[.…—-]/u.test(previous)) return 40;
    let i = end - 1;
    while (i >= 0 && closing.test(this.points[i])) i--;
    const point = this.points[i] ?? '';
    if (/[\r\n]/u.test(point)) return 0;
    const numeric = /[.,]/.test(point) && /\d/.test(this.points[i - 1] ?? '') && /\d/.test(this.points[i + 1] ?? '');
    if (!numeric && /[。！？.!?]/u.test(point)) return 1;
    if (/[；;]/u.test(point)) return 3;
    if (!numeric && /[，：,:]/u.test(point)) return 5;
    if (/[、]/u.test(point)) return 7;
    if (/^\s+$/u.test(previous)) return 8;
    if (numeric || word.test(previous) && word.test(next)) return 35;
    if (word.test(previous) !== word.test(next)) return 8;
    return 18;
  }
  candidates(start: number, capacity: number): Candidate[] {
    let limit = start;
    while (limit < this.points.length && this.width(start, limit + 1) <= capacity) limit++;
    if (limit === start) limit++;
    const candidates: Candidate[] = [];
    for (let end = start + 1; end <= limit; end++) {
      const quality = this.boundaries[end - 1];
      if (end !== limit && end !== this.points.length && quality >= 18 && (quality > 18 || end < limit - 3)) continue;
      const ratio = this.width(start, end) / capacity;
      const whitespace = end === this.points.length ? 0 : 8 * (1 - ratio) ** 2 + 100 * Math.max(0, 0.55 - ratio) ** 2;
      const tail = this.width(end, this.points.length);
      const orphan = tail > 0 && tail < capacity * 0.25 ? 10 * (1 - tail / (capacity * 0.25)) : 0;
      candidates.push({ end, quality, cost: quality + whitespace + orphan + 2 });
    }
    const best = candidates.sort((a, b) => a.cost - b.cost || b.end - a.end).slice(0, 12);
    const fullest = candidates.find(candidate => candidate.end === limit)!;
    if (!best.includes(fullest)) best.push(fullest);
    return best;
  }
  plan(start: number, capacity: number, slots: number): number[] {
    if (start >= this.points.length) return [];
    const memo = new Map<string, { cost: number; ends: number[] }>();
    const candidates = new Map<number, Candidate[]>();
    const solve = (position: number, depth: number): { cost: number; ends: number[] } => {
      if (position >= this.points.length || depth === slots * 2) return { cost: 0, ends: [] };
      const key = `${position}:${depth}`;
      const cached = memo.get(key); if (cached) return cached;
      let options = candidates.get(position);
      if (!options) { options = this.candidates(position, capacity); candidates.set(position, options); }
      let best = { cost: Infinity, ends: [] as number[] };
      for (const option of options) {
        const rest = solve(option.end, depth + 1);
        const screenEnd = (depth + 1) % slots === 0;
        const cost = option.cost + (screenEnd ? option.quality * 0.8 : 0) + rest.cost;
        if (cost < best.cost || cost === best.cost && option.end > (best.ends[0] ?? 0)) best = { cost, ends: [option.end, ...rest.ends] };
      }
      memo.set(key, best); return best;
    };
    return solve(start, 0).ends.slice(0, slots);
  }
  display(start: number, end: number) {
    return this.points.slice(start, end).join('').replace(/[\r\n\t]/g, ' ').replace(/\$\(/g, '$\u200b(');
  }
}

/** Compatibility helper; production uses the shared layout's chunks directly. */
export function splitStatusText(text: string, capacity: number): string[] {
  const chapter = new Chapter(text), chunks: string[] = [];
  for (let start = 0; start < chapter.points.length;) {
    const end = chapter.plan(start, Math.max(4, capacity), 1)[0];
    chunks.push(chapter.points.slice(start, end).join('')); start = end;
  }
  return chunks;
}

/** Stable source anchor and back history; resizing never rewinds the current start. */
export class ReadingText {
  private chapter = new Chapter('');
  private capacity = 60;
  private slots = 1;
  private start = 0;
  private ends: number[] = [];
  private history: number[] = [];
  private identity = '';
  set(identity: string, text: string) {
    if (identity === this.identity) return;
    this.identity = identity; this.chapter = new Chapter(text); this.start = 0; this.history = []; this.layout();
  }
  resize(capacity: number, slots = 1) {
    const next = Math.max(4, Math.floor(capacity)); slots = Math.max(1, Math.min(3, Math.floor(slots)));
    if (this.capacity !== next || this.slots !== slots) { this.capacity = next; this.slots = slots; this.layout(); }
  }
  private layout() { this.ends = this.chapter.plan(this.start, this.capacity, this.slots); }
  next(): boolean {
    const end = this.ends.at(-1) ?? 0;
    if (end >= this.chapter.points.length) return false;
    this.history.push(this.start); this.start = end; this.layout(); return true;
  }
  previous() { const previous = this.history.pop(); if (previous !== undefined) { this.start = previous; this.layout(); } }
  view() {
    let start = this.start;
    const chunks = this.ends.map(end => { const value = this.chapter.display(start, end); start = end; return value; });
    const last = (this.ends.at(-1) ?? 0) >= this.chapter.points.length;
    const offset = this.chapter.offsets[this.start];
    return { text: chunks.join(''), chunks, offset, end: this.chapter.offsets[start], progress: offset === 0 ? 0 : last ? 100 : Math.floor(offset / Math.max(1, this.chapter.text.length - 1) * 100), last };
  }
}
