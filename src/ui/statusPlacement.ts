/** Native status items expose neither their width nor their neighbours' widths. */
export function statusPlacement(windowWidth: number, widthPercent: number, offsetPercent: number) {
  const offset = Number.isFinite(offsetPercent) ? Math.max(0, Math.min(100, offsetPercent)) : 0;
  const right = offset > 50;
  // Reserve room for chapter/progress and the usual workbench status items.
  const remaining = Math.max(0, windowWidth * (1 - widthPercent / 100) - 360);
  const padding = remaining * (right ? 1 - offset / 100 : offset / 100);
  // EM SPACE is approximately 12 logical pixels in the native status font.
  // Split padding so no item approaches VS Code's 40vw item cap.
  const capacity = Math.max(1, Math.floor((windowWidth * 0.3 - 16) / 12));
  let spaces = Math.max(0, Math.floor((padding - 16) / 12));
  const chunks: string[] = [];
  while (spaces > 0 && chunks.length < 3) {
    const count = Math.min(spaces, capacity);
    chunks.push('\u2003'.repeat(count));
    spaces -= count;
  }
  return { right, chunks };
}
