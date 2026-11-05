/**
 * Outer-silhouette track for the brand wordmark.
 *
 * Instead of crawling every glyph contour (and diving into counters like the
 * eyes of the e's), the slime blob traces one clean loop around the word's
 * outer silhouette: just the outline, then it jumps off, plays, and returns.
 *
 * How the silhouette is found: the wordmark path is stroked on an offscreen
 * canvas with a wide round stroke whose radius equals the blob radius.
 * Stroking dilates the glyphs, so the outer edge of the stroke is the word's
 * silhouette offset outward by exactly the blob radius — a blob centered on
 * that edge kisses the letters as it travels. We keep the largest white
 * component, walk its outer boundary, resample to even spacing, and hand the
 * loop back in wordmark coordinates.
 *
 * This needs DOM canvas, so it only runs in the browser. Outside the browser
 * (tests, SSR) `traceWordOutline` returns null and `buildBrandFrame` falls
 * back to the legacy contour-crawling track.
 */

export type OutlinePt = { x: number; y: number };

const RASTER_SCALE = 3;
const OUTLINE_SPACING = 1.8;

const DIRS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

/** Largest 8-connected white component of a binary mask, as a mask. */
export function largestWhiteComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h).fill(-1);
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  let bestLabel = -1;
  let bestSize = 0;
  let nextLabel = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || labels[i] >= 0) continue;
    let size = 0;
    stack.push(i);
    labels[i] = nextLabel;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      size += 1;
      const x = cur % w;
      const y = (cur / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] && labels[ni] < 0) {
          labels[ni] = nextLabel;
          stack.push(ni);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = nextLabel;
    }
    nextLabel += 1;
  }
  if (bestLabel < 0) return out;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === bestLabel) out[i] = 1;
  }
  return out;
}

function erode8(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      out[i] =
        mask[i] &&
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - w] &&
        mask[i + w] &&
        mask[i - w - 1] &&
        mask[i - w + 1] &&
        mask[i + w - 1] &&
        mask[i + w + 1]
          ? 1
          : 0;
    }
  }
  return out;
}

/** Boundary pixels (8-connected outline) of the largest white component. */
export function boundaryOfLargestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const comp = largestWhiteComponent(mask, w, h);
  const eroded = erode8(comp, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) {
    if (comp[i] && !eroded[i]) out[i] = 1;
  }
  return out;
}

/**
 * Order boundary pixels into a loop with Moore-neighbor tracing: start at
 * the topmost-leftmost boundary pixel and walk clockwise, always examining
 * neighbors from just past the direction we came from. This keeps the
 * background on a consistent side, so the walk follows the outer edge even
 * on boundaries two pixels thick, and stops once the loop closes.
 */
export function traceBoundary(boundary: Uint8Array, w: number, h: number): OutlinePt[] | null {
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (boundary[row + x]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;
  // DIRS is clockwise in screen coords (y down): E, SE, S, SW, W, NW, N, NE.
  const WEST = 4;
  const pts: OutlinePt[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let back = WEST; // direction we arrived from; west is background by construction
  for (let guard = 0; guard < w * h; guard += 1) {
    let next = -1;
    for (let k = 1; k <= 8; k += 1) {
      const idx = (back + k) % 8;
      const nx = cx + DIRS[idx][0];
      const ny = cy + DIRS[idx][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (boundary[ny * w + nx]) {
        next = idx;
        break;
      }
    }
    if (next < 0) return pts.length >= 8 ? pts : null;
    const nx = cx + DIRS[next][0];
    const ny = cy + DIRS[next][1];
    if (nx === sx && ny === sy && pts.length > 8) {
      return pts; // loop closed
    }
    pts.push({ x: nx, y: ny });
    back = (next + 4) % 8; // new backtrack: opposite of the step we took
    cx = nx;
    cy = ny;
  }
  return pts.length >= 8 ? pts : null;
}

/** Even arc-length resampling of a closed loop. */
export function resampleLoop(pts: OutlinePt[], spacing: number): OutlinePt[] {
  if (pts.length < 2) return pts.slice();
  const src = pts.concat([pts[0]]);
  const out: OutlinePt[] = [{ x: src[0].x, y: src[0].y }];
  let ax = src[0].x;
  let ay = src[0].y;
  let remain = spacing;
  for (let i = 1; i < src.length; i += 1) {
    const bx = src[i].x;
    const by = src[i].y;
    let seg = Math.hypot(bx - ax, by - ay);
    if (seg < 1e-4) continue;
    while (seg >= remain) {
      const t = remain / seg;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push({ x: ax, y: ay });
      seg = Math.hypot(bx - ax, by - ay);
      remain = spacing;
    }
    remain -= seg;
    ax = bx;
    ay = by;
  }
  if (out.length > 2) {
    const last = out[out.length - 1];
    const first = out[0];
    if (Math.hypot(last.x - first.x, last.y - first.y) < spacing * 0.65) out.pop();
  }
  return out;
}

/** Rotate the loop so it starts at the top (slight bias toward center). */
export function startAtTop(pts: OutlinePt[]): OutlinePt[] {
  if (pts.length === 0) return pts;
  let cx = 0;
  for (const p of pts) cx += p.x;
  cx /= pts.length;
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const score = pts[i].y + 0.35 * Math.abs(pts[i].x - cx);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return pts.slice(best).concat(pts.slice(0, best));
}

/**
 * Trace the wordmark's outer silhouette. `d` is the wordmark SVG path data
 * in the same coordinate space as the `w` x `h` viewBox; `blobRadius` is in
 * the same units. Returns the loop in wordmark coordinates, or null when
 * canvas is unavailable or the trace fails (caller falls back).
 */
export function traceWordOutline(
  d: string,
  w: number,
  h: number,
  blobRadius: number,
): OutlinePt[] | null {
  if (typeof document === "undefined") return null;
  try {
    const scale = RASTER_SCALE;
    const margin = Math.ceil(blobRadius * 2);
    const cw = Math.max(8, Math.ceil((w + margin * 2) * scale));
    const ch = Math.max(8, Math.ceil((h + margin * 2) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, margin * scale, margin * scale);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = blobRadius * 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(new Path2D(d));
    const img = ctx.getImageData(0, 0, cw, ch).data;
    const mask = new Uint8Array(cw * ch);
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = img[i * 4] > 127 ? 1 : 0;
    }
    const boundary = boundaryOfLargestComponent(mask, cw, ch);
    const walked = traceBoundary(boundary, cw, ch);
    if (!walked || walked.length < 24) return null;
    const inv = 1 / scale;
    const inWord = walked.map((p) => ({ x: p.x * inv - margin, y: p.y * inv - margin }));
    const even = resampleLoop(inWord, OUTLINE_SPACING);
    if (even.length < 8) return null;
    return startAtTop(even);
  } catch {
    return null;
  }
}
