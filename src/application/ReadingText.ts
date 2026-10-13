export function textCells(character: string): number {
  if (character === '\u200b') return 0;
  return /[\u0000-\u007f]/.test(character) && !/[MW@%#&]/.test(character) ? 0.75 : 1;
}
/** Prefer a natural boundary in the last 40% of the available width. */
function segmentEnd(points: string[], start: number, capacity: number): number {
  let end = start, width = 0, preferred = start;
  while (end < points.length) {
    const next = textCells(points[end]);
    if (end > start && width + next > capacity) break;
    width += next;
    const character = points[end++];
    const numericSeparator = /[.,]/.test(character) && /\d/.test(points[end - 2] ?? '') && /\d/.test(points[end] ?? '');
    if (width >= capacity * 0.6 && /[，。；！？、：,.;!?:\n]/.test(character) && !numericSeparator) preferred = end;
    // Keep closing punctuation with the sentence when it still fits.
    else if (preferred > start && preferred === end - 1 && /[”’」』）】"')\]]/.test(character)) preferred = end;
  }
  return end === points.length ? end : preferred > start ? preferred : end;
}
/** Split the visible segment across native items without losing any characters. */
export function splitStatusText(text: string, capacity: number): string[] {
  const points = Array.from(text), chunks: string[] = [];
  for (let start = 0; start < points.length;) {
    const end = segmentEnd(points, start, Math.max(1, capacity));
    chunks.push(points.slice(start, end).join('')); start = end;
  }
  return chunks;
}
/** Character offsets survive changes in width; no chapter text is written to logs. */
export class ReadingText {
  private text = '';
  private points: string[] = [];
  private starts: number[] = [0];
  private capacity = 60;
  private slots = 1;
  private offset = 0;
  private identity = '';
  set(identity: string, text: string) {
    if (identity === this.identity) return;
    this.identity = identity; this.text = text; this.offset = 0;
    this.points = Array.from(text.replace(/[\r\n\t]/g, ' '));
    this.layout();
  }
  resize(capacity: number, slots = 1) {
    const next = Math.max(4, Math.floor(capacity)); slots = Math.max(1, Math.floor(slots));
    if (this.capacity !== next || this.slots !== slots) { this.capacity = next; this.slots = slots; this.layout(); }
  }
  private layout() {
    this.starts = [0]; let end = 0;
    while (end < this.points.length) {
      for (let slot = 0; slot < this.slots && end < this.points.length; slot++) end = segmentEnd(this.points, end, this.capacity);
      if (end < this.points.length) this.starts.push(end);
    }
  }
  private index() { for (let i = this.starts.length - 1; i >= 0; i--) if (this.starts[i] <= this.offset) return i; return 0; }
  next(): boolean { const next = this.starts[this.index() + 1]; if (next === undefined) return false; this.offset = next; return true; }
  previous() { this.offset = this.starts[Math.max(0, this.index() - 1)]; }
  view() {
    const index = this.index(); const start = this.starts[index], end = this.starts[index + 1] ?? this.points.length;
    const value = this.points.slice(start, end).join('').replace(/[\r\n\t]/g, ' ').replace(/\$\(/g, '$\u200b(');
    return { text: value, offset: this.offset, progress: this.offset === 0 ? 0 : index === this.starts.length - 1 ? 100 : Math.floor(this.offset / Math.max(1, this.points.length - 1) * 100), last: index === this.starts.length - 1 };
  }
}
