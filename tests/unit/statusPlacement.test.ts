import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusPlacement } from '../../src/ui/statusPlacement';

test('status reading endpoints use native alignment without padding', () => {
  assert.deepEqual(statusPlacement(1920, 70, 0), { right: false, chunks: [] });
  assert.deepEqual(statusPlacement(1920, 70, 100), { right: true, chunks: [] });
  assert.deepEqual(statusPlacement(1920, 70, -20), statusPlacement(1920, 70, 0));
  assert.deepEqual(statusPlacement(1920, 70, 120), statusPlacement(1920, 70, 100));
});

test('placement reserves controls, bounds native item widths and reduces padding on narrow windows', () => {
  for (const width of [400, 1000, 1920, 4000, 16000]) {
    for (const percentage of [10, 60, 70, 80]) {
      for (const offset of [10, 50, 51, 75, 90]) {
        const layout = statusPlacement(width, percentage, offset);
        assert.ok(layout.chunks.length <= 3);
        for (const chunk of layout.chunks) assert.ok(chunk.length * 12 + 16 <= width * 0.3);
        const padding = layout.chunks.reduce((sum, chunk) => sum + chunk.length * 12, 0);
        assert.ok(padding <= Math.max(0, width * (1 - percentage / 100) - 360));
      }
    }
  }
  assert.equal(statusPlacement(400, 70, 50).chunks.length, 0);
  assert.ok(statusPlacement(1920, 70, 50).chunks.length > 0);
});
