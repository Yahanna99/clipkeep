import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundaryOfLargestComponent,
  largestWhiteComponent,
  resampleLoop,
  startAtTop,
  traceBoundary,
  type OutlinePt,
} from "./outline.ts";

function discMask(w: number, h: number, cx: number, cy: number, r: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function tracedDisc(): OutlinePt[] {
  const w = 96;
  const h = 96;
  const mask = discMask(w, h, 48, 48, 30);
  const loop = traceBoundary(boundaryOfLargestComponent(mask, w, h), w, h);
  assert.ok(loop, "expected a traced loop");
  return loop ?? [];
}

describe("outline silhouette helpers", () => {
  it("keeps the largest white component", () => {
    const w = 64;
    const h = 64;
    const mask = discMask(w, h, 16, 16, 8);
    const big = discMask(w, h, 44, 44, 14);
    for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] || big[i];
    const kept = largestWhiteComponent(mask, w, h);
    assert.equal(kept[16 * w + 16], 0);
    assert.equal(kept[44 * w + 44], 1);
  });

  it("traces a closed loop hugging the shape", () => {
    const pts = tracedDisc();
    assert.ok(pts.length > 100, `loop had ${pts.length} points`);
    const first = pts[0];
    const last = pts[pts.length - 1];
    assert.ok(Math.hypot(last.x - first.x, last.y - first.y) < 3, "loop should close");
    for (const p of pts) {
      const d = Math.hypot(p.x - 48, p.y - 48);
      assert.ok(Math.abs(d - 30) < 2.5, `off-circle point at radius ${d}`);
    }
  });

  it("resamples to even spacing and starts at the top", () => {
    const even = resampleLoop(tracedDisc(), 2);
    assert.ok(even.length > 40, `resampled to ${even.length} points`);
    let maxGap = 0;
    for (let i = 1; i < even.length; i += 1) {
      maxGap = Math.max(maxGap, Math.hypot(even[i].x - even[i - 1].x, even[i].y - even[i - 1].y));
    }
    assert.ok(maxGap < 2 * 3.2, `gap ${maxGap}`);
    const top = startAtTop(even);
    assert.ok(top[0].y < 48 - 30 + 4, `starts at y=${top[0].y}`);
    assert.ok(Math.abs(top[0].x - 48) < 30 * 0.5, `starts at x=${top[0].x}`);
  });
});
