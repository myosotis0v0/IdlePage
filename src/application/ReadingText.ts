export function textCells(character: string): number {
  if (character === '\u200b') return 0;
  return /[\u0000-\u007f]/.test(character) && !/[MW@%#&]/.test(character) ? 0.75 : 1;
}
/** Split the visible segment across native items without losing any characters. */
export function splitStatusText(text: string, capacity: number): string[] {
  const chunks: string[] = []; let current = ''; let width = 0;
  for (const character of text) {
    const next = textCells(character);
    if (current && width + next > capacity) { chunks.push(current); current = ''; width = 0; }
    current += character; width += next;
  }
  if (current) chunks.push(current);
  return chunks;
}
/** Character offsets survive changes in width; no chapter text is written to logs. */
export class ReadingText {
  private text = '';
  private points: string[] = [];
  private widths: number[] = [];
  private starts: number[] = [0];
  private capacity = 60;
  private offset = 0;
  private identity = '';
  set(identity: string, text: string) {
    if (identity === this.identity) return;
    this.identity = identity; this.text = text; this.offset = 0;
    this.points = Array.from(text);
    this.widths = this.points.map(textCells);
    this.layout();
  }
  resize(capacity: number) { const next = Math.max(4, Math.floor(capacity)); if (this.capacity !== next) { this.capacity = next; this.layout(); } }
  private layout() {
    this.starts = [0]; let width = 0;
    for (let i = 0; i < this.points.length; i++) {
      if (width + this.widths[i] > this.capacity && i > this.starts.at(-1)!) { this.starts.push(i); width = 0; }
      width += this.widths[i];
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
