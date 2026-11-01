/**
 * Clipkeep wordmark outline + slime motion.
 *
 * Samples are built once from the real glyph contours. The animation loop only
 * interpolates those samples and writes a CSS transform, so it never calls
 * getPointAtLength or reads layout per frame.
 */

export const WORD = "clipkeep";
export const DESKTOP_FONT_SIZE = 72;
export const MOBILE_FONT_SIZE = 52;
export const LAUNCH_MS = 340;
export const RETURN_MS = 420;
export const PLAY_MIN_MS = 1100;
export const PLAY_MAX_MS = 1550;
export const LOGO_HOP_MS = 780;
export const LOGO_DELAY_MIN_MS = 10_000;
export const LOGO_DELAY_MAX_MS = 15_000;

const SPACING = 1.8;
const TRACE_SECONDS = 8.4;
const LETTER_SPACING = -0.04;

export type Pt = { x: number; y: number };

export type Track = {
  xs: Float32Array;
  ys: Float32Array;
  letters: Uint8Array;
  count: number;
  spacing: number;
  length: number;
  speed: number;
};

export type BrandFrame = {
  d: string;
  w: number;
  h: number;
  fontSize: number;
  track: Track;
};

export type Phase = "trace" | "launch" | "play" | "return";

export type Sim = {
  phase: Phase;
  index: number;
  elapsed: number;
  playMs: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  arc: number;
  wobble: number;
};

export type Sample = { x: number; y: number; tx: number; ty: number };

export type Pose = Sample & {
  phase: Phase;
  sx: number;
  sy: number;
  /** 0–1, how far splatter droplets travel. */
  burst: number;
};

type Cmd =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "Q"; x: number; y: number; x1: number; y1: number }
  | { type: "C"; x: number; y: number; x1: number; y1: number; x2: number; y2: number }
  | { type: "Z" };

type GlyphLike = {
  commands: ReadonlyArray<{
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }>;
};

export type BrandFont = {
  getPath: (text: string, x: number, y: number, fontSize: number, options?: object) => {
    getBoundingBox: () => { x1: number; y1: number; x2: number; y2: number };
    toPathData: (decimalPlaces: number) => string;
  };
  getPaths: (text: string, x: number, y: number, fontSize: number, options?: object) => GlyphLike[];
};

type Contour = {
  pts: Pt[];
  poly: Pt[];
  minX: number;
  area: number;
  centroid: Pt;
};

type Shape = { outer: Contour; holes: Contour[] };

const PARTS = [
  { x: 0.02, y: 0.0, r: 0.19 },
  { x: -0.05, y: 0.025, r: 0.16 },
  { x: 0.03, y: -0.05, r: 0.11 },
  { x: 0.11, y: 0.07, r: 0.09 },
  { x: -0.16, y: 0.01, r: 0.11 },
  { x: -0.28, y: -0.035, r: 0.075 },
  { x: -0.38, y: 0.03, r: 0.048 },
  { x: -0.2, y: 0.13, r: 0.062 },
  { x: -0.24, y: 0.22, r: 0.04 },
  { x: -0.08, y: -0.15, r: 0.062 },
  { x: 0.14, y: -0.02, r: 0.055 },
];

export function nextLogoDelayMs(random: () => number = Math.random) {
  return LOGO_DELAY_MIN_MS + random() * (LOGO_DELAY_MAX_MS - LOGO_DELAY_MIN_MS);
}

export function randomPlayMs(random: () => number = Math.random) {
  return PLAY_MIN_MS + random() * (PLAY_MAX_MS - PLAY_MIN_MS);
}

export function createSim(playMs = PLAY_MIN_MS): Sim {
  return {
    phase: "trace",
    index: 0,
    elapsed: 0,
    playMs,
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    arc: 24,
    wobble: 8,
  };
}

export function sampleAt(track: Track, index: number): Sample {
  const max = Math.max(0, track.count - 1);
  const i = Math.min(max, Math.max(0, index));
  const i0 = Math.min(Math.max(0, max - 1), Math.floor(i));
  const i1 = Math.min(max, i0 + 1);
  const f = i1 === i0 ? 0 : Math.min(1, i - i0);
  const x = track.xs[i0] * (1 - f) + track.xs[i1] * f;
  const y = track.ys[i0] * (1 - f) + track.ys[i1] * f;
  const a = Math.max(0, i0 - 2);
  const b = Math.min(max, i0 + 3);
  let tx = track.xs[b] - track.xs[a];
  let ty = track.ys[b] - track.ys[a];
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  return { x, y, tx, ty };
}

function clamp01(t: number) {
  return Math.min(1, Math.max(0, t));
}

function easeInOut(t: number) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOut(t: number) {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function poseOf(sim: Sim, track: Track, now: number): Pose {
  if (sim.phase === "trace") {
    const sample = track.count ? sampleAt(track, sim.index) : { x: 0, y: 0, tx: 1, ty: 0 };
    const wob = Math.sin(now / 170);
    return {
      ...sample,
      phase: "trace",
      sx: 1.14 + wob * 0.05,
      sy: 0.88 - wob * 0.045,
      burst: 0,
    };
  }

  if (sim.phase === "launch") {
    const p = easeInOut(sim.elapsed / LAUNCH_MS);
    const stretch = Math.sin(p * Math.PI);
    const dx = sim.toX - sim.fromX;
    const dy = sim.toY - sim.fromY;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: lerp(sim.fromX, sim.toX, p),
      y: lerp(sim.fromY, sim.toY, p) - Math.sin(p * Math.PI) * sim.arc,
      tx: dx / len,
      ty: dy / len,
      phase: "launch",
      sx: lerp(1.15, 1.95, stretch),
      sy: lerp(0.95, 0.52, stretch),
      burst: stretch * 0.45,
    };
  }

  if (sim.phase === "play") {
    const t = clamp01(sim.elapsed / sim.playMs);
    const land = Math.exp(-t * 5.5);
    const pulse = Math.sin(t * Math.PI * 6.5);
    const rock = t * Math.PI * 2;
    return {
      x: sim.toX + Math.cos(rock) * sim.wobble,
      y: sim.toY + Math.sin(rock * 1.35) * sim.wobble * 0.85 + land * sim.wobble * 0.35,
      tx: Math.cos(rock * 0.5),
      ty: Math.sin(rock * 0.5) * 0.35,
      phase: "play",
      sx: 1.45 + land * 0.5 + pulse * 0.28,
      sy: 1.2 - land * 0.38 - pulse * 0.24,
      burst: Math.sin(Math.min(1, t * 1.25) * Math.PI),
    };
  }

  const p = easeOut(sim.elapsed / RETURN_MS);
  const dx = sim.toX - sim.fromX;
  const dy = sim.toY - sim.fromY;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: lerp(sim.fromX, sim.toX, p),
    y: lerp(sim.fromY, sim.toY, p) - Math.sin(p * Math.PI) * sim.arc * 0.72,
    tx: dx / len,
    ty: dy / len,
    phase: "return",
    sx: lerp(1.4, 1.12, p),
    sy: lerp(0.68, 0.9, p),
    burst: (1 - p) * 0.28,
  };
}

export type LaunchTarget = { x: number; y: number; arc: number; wobble: number };

export function advanceSim(
  sim: Sim,
  track: Track,
  dt: number,
  hooks: {
    launchTarget: (from: Pt) => LaunchTarget;
    nextPlayMs: () => number;
  },
): Sim {
  const step = Math.min(40, Math.max(0, dt));
  if (track.count < 2) return sim;

  if (sim.phase === "trace") {
    const index = sim.index + (track.speed / track.spacing) * (step / 1000);
    if (index < track.count - 1) return { ...sim, index };
    const end = sampleAt(track, track.count - 1);
    const target = hooks.launchTarget(end);
    return {
      phase: "launch",
      index: track.count - 1,
      elapsed: 0,
      playMs: sim.playMs,
      fromX: end.x,
      fromY: end.y,
      toX: target.x,
      toY: target.y,
      arc: target.arc,
      wobble: target.wobble,
    };
  }

  if (sim.phase === "launch") {
    const elapsed = sim.elapsed + step;
    if (elapsed < LAUNCH_MS) return { ...sim, elapsed };
    return { ...sim, phase: "play", elapsed: 0 };
  }

  if (sim.phase === "play") {
    const elapsed = sim.elapsed + step;
    if (elapsed < sim.playMs) return { ...sim, elapsed };
    const landing = poseOf({ ...sim, elapsed: sim.playMs }, track, 0);
    const start = sampleAt(track, 0);
    return {
      phase: "return",
      index: 0,
      elapsed: 0,
      playMs: hooks.nextPlayMs(),
      fromX: landing.x,
      fromY: landing.y,
      toX: start.x,
      toY: start.y,
      arc: sim.arc * 0.85,
      wobble: sim.wobble,
    };
  }

  const elapsed = sim.elapsed + step;
  if (elapsed < RETURN_MS) return { ...sim, elapsed };
  return { ...sim, phase: "trace", index: 0, elapsed: 0 };
}

export function splatOffsets(burst: number, now: number, fontSize: number) {
  const reach = fontSize * 0.62 * burst;
  const angles = [0.5, 1.35, 2.15, 2.9, 4.05, 5.15];
  return angles.map((angle, i) => {
    const wob = Math.sin(now / 150 + i * 1.7) * fontSize * 0.02;
    const dist = reach * (0.62 + (i % 3) * 0.16);
    return {
      x: Math.cos(angle) * dist + wob,
      y: Math.sin(angle) * dist + burst * burst * fontSize * 0.06,
      scale: burst * (0.85 + (i % 3) * 0.35),
    };
  });
}

export function blobPixelSize(fontSize: number) {
  return Math.ceil(fontSize * 1.7);
}

export function blobSvg(fontSize: number): { svg: string; size: number } {
  const s = fontSize;
  const parts = PARTS.map((part) => ({
    x: part.x * s,
    y: part.y * s,
    rx: part.r * s,
    ry: part.r * s * 0.9,
  }));
  const size = blobPixelSize(s);
  const half = size / 2;
  const blur = (s * 0.046).toFixed(2);
  const circles = parts
    .map(
      (part) =>
        `<ellipse cx="${part.x.toFixed(2)}" cy="${part.y.toFixed(2)}" rx="${part.rx.toFixed(2)}" ry="${part.ry.toFixed(2)}"/>`,
    )
    .join("");
  const hx = (0.04 * s).toFixed(2);
  const hy = (-0.09 * s).toFixed(2);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-half} ${-half} ${size} ${size}">
  <defs>
    <filter id="goo" filterUnits="userSpaceOnUse" x="${-half}" y="${-half}" width="${size}" height="${size}" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/>
      <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"/>
    </filter>
    <radialGradient id="gloss" cx="30%" cy="28%" r="58%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="16%" stop-color="#e7f0ff" stop-opacity="0.7"/>
      <stop offset="42%" stop-color="#9eb4d4" stop-opacity="0.18"/>
      <stop offset="72%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g filter="url(#goo)" fill="#07080d">${circles}</g>
  <ellipse cx="${hx}" cy="${hy}" rx="${(0.13 * s).toFixed(2)}" ry="${(0.07 * s).toFixed(2)}" fill="url(#gloss)" transform="rotate(-28 ${hx} ${hy})"/>
  <ellipse cx="${(-0.01 * s).toFixed(2)}" cy="${(-0.01 * s).toFixed(2)}" rx="${(0.04 * s).toFixed(2)}" ry="${(0.022 * s).toFixed(2)}" fill="#ffffff" fill-opacity="0.42" transform="rotate(-36 ${(-0.01 * s).toFixed(2)} ${(-0.01 * s).toFixed(2)})"/>
</svg>`;
  return { svg, size };
}

function num(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readCommands(glyph: GlyphLike): Cmd[] {
  const cmds: Cmd[] = [];
  for (const cmd of glyph.commands) {
    if (cmd.type === "M" || cmd.type === "L") cmds.push({ type: cmd.type, x: num(cmd.x), y: num(cmd.y) });
    else if (cmd.type === "Q") {
      cmds.push({ type: "Q", x: num(cmd.x), y: num(cmd.y), x1: num(cmd.x1), y1: num(cmd.y1) });
    } else if (cmd.type === "C") {
      cmds.push({
        type: "C",
        x: num(cmd.x),
        y: num(cmd.y),
        x1: num(cmd.x1),
        y1: num(cmd.y1),
        x2: num(cmd.x2),
        y2: num(cmd.y2),
      });
    } else if (cmd.type === "Z") cmds.push({ type: "Z" });
  }
  return cmds;
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pushFlat(out: Pt[], pt: Pt) {
  const last = out[out.length - 1];
  if (!last || (last.x - pt.x) ** 2 + (last.y - pt.y) ** 2 > 1e-6) out.push(pt);
}

function flatQuad(out: Pt[], p0: Pt, p1: Pt, p2: Pt, depth: number) {
  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const d = (p1.x - p2.x) * dy - (p1.y - p2.y) * dx;
  if (d * d <= 0.35 * 0.35 * (dx * dx + dy * dy) || depth > 10) {
    pushFlat(out, p2);
    return;
  }
  const a = mid(p0, p1);
  const b = mid(p1, p2);
  const m = mid(a, b);
  flatQuad(out, p0, a, m, depth + 1);
  flatQuad(out, m, b, p2, depth + 1);
}

function flatCubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt, depth: number) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  if ((d1 + d2) * (d1 + d2) <= 0.45 * 0.45 * (dx * dx + dy * dy) || depth > 10) {
    pushFlat(out, p3);
    return;
  }
  const a = mid(p0, p1);
  const b = mid(p1, p2);
  const c = mid(p2, p3);
  const d = mid(a, b);
  const e = mid(b, c);
  const f = mid(d, e);
  flatCubic(out, p0, a, d, f, depth + 1);
  flatCubic(out, f, e, c, p3, depth + 1);
}

function contoursFrom(commands: Cmd[]): Pt[][] {
  const contours: Pt[][] = [];
  let current: Pt[] | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const ensure = () => {
    if (!current) {
      current = [];
      contours.push(current);
    }
    return current;
  };
  for (const cmd of commands) {
    if (cmd.type === "M") {
      current = [];
      contours.push(current);
      x = cmd.x;
      y = cmd.y;
      sx = x;
      sy = y;
      pushFlat(current, { x, y });
    } else if (cmd.type === "L") {
      const pts = ensure();
      pushFlat(pts, { x: cmd.x, y: cmd.y });
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === "Q") {
      const pts = ensure();
      flatQuad(pts, { x, y }, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }, 0);
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === "C") {
      const pts = ensure();
      flatCubic(pts, { x, y }, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, { x: cmd.x, y: cmd.y }, 0);
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === "Z") {
      if (current && Math.hypot(x - sx, y - sy) > 0.01) pushFlat(current, { x: sx, y: sy });
      x = sx;
      y = sy;
    }
  }
  return contours.filter((contour) => contour.length >= 3);
}

function resample(points: Pt[], spacing: number, closed: boolean): Pt[] {
  if (!points.length) return [];
  const src =
    closed && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) > 0.01
      ? points.concat([points[0]])
      : points.slice();
  if (src.length === 1) return [{ ...src[0] }];
  const out: Pt[] = [{ ...src[0] }];
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
  if (closed && out.length > 2) {
    const last = out[out.length - 1];
    if (Math.hypot(last.x - out[0].x, last.y - out[0].y) < spacing * 0.65) out.pop();
  }
  return out;
}

function shoelace(pts: Pt[]) {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return area / 2;
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const pt of pts) {
    x += pt.x;
    y += pt.y;
  }
  const n = pts.length || 1;
  return { x: x / n, y: y / n };
}

function inside(pt: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const yi = poly[i].y;
    const yj = poly[j].y;
    const xi = poly[i].x;
    const xj = poly[j].x;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 0) + xi) hit = !hit;
  }
  return hit;
}

function nearestIndex(pts: Pt[], target: Pt) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = (pts[i].x - target.x) ** 2 + (pts[i].y - target.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function loopFrom(pts: Pt[], start: number) {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i += 1) out.push(pts[(start + i) % pts.length]);
  return out;
}

function walk(pts: Pt[], from: number, to: number) {
  const out: Pt[] = [];
  let i = from;
  for (let guard = 0; guard <= pts.length; guard += 1) {
    out.push(pts[i]);
    if (i === to) break;
    i = (i + 1) % pts.length;
  }
  return out;
}

function toContour(poly: Pt[]): Contour | null {
  const pts = resample(poly, SPACING, true);
  if (pts.length < 6) return null;
  let minX = Infinity;
  for (const pt of pts) if (pt.x < minX) minX = pt.x;
  return {
    pts,
    poly,
    minX,
    area: Math.abs(shoelace(poly)),
    centroid: centroid(poly),
  };
}

function shapesOf(commands: Cmd[]): Shape[] {
  const contours = contoursFrom(commands)
    .map(toContour)
    .filter((contour): contour is Contour => contour !== null);
  const parent = contours.map(() => -1);
  for (let i = 0; i < contours.length; i += 1) {
    let parentArea = Infinity;
    for (let j = 0; j < contours.length; j += 1) {
      if (i === j) continue;
      if (
        contours[j].area > contours[i].area * 1.08 &&
        inside(contours[i].centroid, contours[j].poly) &&
        contours[j].area < parentArea
      ) {
        parent[i] = j;
        parentArea = contours[j].area;
      }
    }
  }
  return contours
    .map((contour, index) => ({ contour, index }))
    .filter((item) => parent[item.index] < 0)
    .sort((a, b) => a.contour.minX - b.contour.minX || b.contour.area - a.contour.area)
    .map((item) => ({
      outer: item.contour,
      holes: contours
        .map((contour, index) => ({ contour, index }))
        .filter((hole) => parent[hole.index] === item.index)
        .sort((a, b) => a.contour.minX - b.contour.minX)
        .map((hole) => hole.contour),
    }));
}

function lineBetween(a: Pt, b: Pt) {
  return resample([a, b], SPACING, false).slice(1, -1);
}

function crosses(pts: Pt[], blockers: Pt[][]) {
  const inner = pts.length > 2 ? pts.slice(1, -1) : [];
  for (const pt of inner) {
    for (const poly of blockers) {
      if (inside(pt, poly)) return true;
    }
  }
  return false;
}

function outsideBridge(a: Pt, b: Pt, blockers: Pt[][]) {
  const straight = resample([a, b], SPACING, false);
  if (!crosses(straight, blockers)) return straight.slice(1, -1);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  let best: Pt[] | null = null;
  let bestMag = Infinity;
  for (const sign of [1, -1]) {
    for (let mag = SPACING * 3; mag <= 110; mag += SPACING * 2) {
      const control = {
        x: (a.x + b.x) / 2 + px * sign * mag,
        y: (a.y + b.y) / 2 + py * sign * mag,
      };
      const curved: Pt[] = [a];
      flatQuad(curved, a, control, b, 0);
      const samples = resample(curved, SPACING, false);
      if (!crosses(samples, blockers) && mag < bestMag) {
        bestMag = mag;
        best = samples.slice(1, -1);
        break;
      }
    }
  }
  return best ?? straight.slice(1, -1);
}

function orient(pts: Pt[], entry: Pt, exit: Pt) {
  const start = nearestIndex(pts, entry);
  const end = nearestIndex(pts, exit);
  const forward = (end - start + pts.length) % pts.length;
  if (forward > pts.length / 2) return pts.slice().reverse();
  return pts;
}

export function buildBrandFrame(font: BrandFont, fontSize: number): BrandFrame {
  const options = { kerning: true, letterSpacing: LETTER_SPACING };
  const probe = font.getPath(WORD, 0, 0, fontSize, options);
  const box = probe.getBoundingBox();
  if (![box.x1, box.y1, box.x2, box.y2].every((value) => Number.isFinite(value))) {
    throw new Error("Clipkeep outline bounds were not finite");
  }
  const pad = Math.max(10, fontSize * 0.14);
  const ox = pad - box.x1;
  const oy = pad - box.y1;
  const filled = font.getPath(WORD, ox, oy, fontSize, options);
  const glyphs = font.getPaths(WORD, ox, oy, fontSize, options);
  const d = filled.toPathData(2).replace(/-?NaN/gi, "0");
  const letters = glyphs.map((glyph) => shapesOf(readCommands(glyph)));
  const blockers = letters.flatMap((shapes) => shapes.map((shape) => shape.outer.poly));

  const xs: number[] = [];
  const ys: number[] = [];
  const letterIds: number[] = [];
  const pushPt = (pt: Pt, letter: number) => {
    const last = xs.length - 1;
    if (last >= 0 && (pt.x - xs[last]) ** 2 + (pt.y - ys[last]) ** 2 < 0.2) return;
    xs.push(pt.x);
    ys.push(pt.y);
    letterIds.push(letter);
  };
  const pushPts = (pts: Pt[], letter: number) => {
    for (const pt of pts) pushPt(pt, letter);
  };

  let cursor: Pt = { x: -1e6, y: 0 };

  for (let li = 0; li < letters.length; li += 1) {
    const shapes = letters[li];
    for (let si = 0; si < shapes.length; si += 1) {
      const shape = shapes[si];
      const nextShape = shapes[si + 1];
      const nextLetter = letters[li + 1];
      const nextAnchor = nextShape
        ? nextShape.outer.centroid
        : nextLetter?.[0]?.outer.centroid ?? { x: cursor.x + fontSize, y: cursor.y };

      const outer = orient(shape.outer.pts, cursor, nextAnchor);
      const start = nearestIndex(outer, cursor);
      pushPts(loopFrom(outer, start), li);
      let at = (start - 1 + outer.length) % outer.length;

      for (const hole of shape.holes) {
        const approach = nearestIndex(outer, hole.centroid);
        if (approach !== at) {
          pushPts(walk(outer, (at + 1) % outer.length, approach), li);
          at = approach;
        }
        const holeStart = nearestIndex(hole.pts, outer[at]);
        pushPts(lineBetween(outer[at], hole.pts[holeStart]), li);
        pushPts(loopFrom(hole.pts, holeStart), li);
        const holeEnd = hole.pts[(holeStart - 1 + hole.pts.length) % hole.pts.length];
        pushPts(lineBetween(holeEnd, outer[at]), li);
      }

      const exit = nearestIndex(outer, nextAnchor);
      if (exit !== at) {
        pushPts(walk(outer, (at + 1) % outer.length, exit), li);
        at = exit;
      }
      cursor = outer[at];

      if (nextShape) {
        const entry = nextShape.outer.pts[nearestIndex(nextShape.outer.pts, cursor)];
        pushPts(lineBetween(cursor, entry), li);
        cursor = entry;
      } else if (nextLetter?.[0]) {
        const entry = nextLetter[0].outer.pts[nearestIndex(nextLetter[0].outer.pts, cursor)];
        pushPts(outsideBridge(cursor, entry, blockers), li + 1);
        cursor = entry;
      }
    }
  }

  if (xs.length < 8) throw new Error("Clipkeep outline was empty");
  const count = xs.length;
  const length = Math.max(SPACING, (count - 1) * SPACING);
  return {
    d,
    w: Math.ceil(box.x2 - box.x1 + pad * 2),
    h: Math.ceil(box.y2 - box.y1 + pad * 2),
    fontSize,
    track: {
      xs: Float32Array.from(xs),
      ys: Float32Array.from(ys),
      letters: Uint8Array.from(letterIds),
      count,
      spacing: SPACING,
      length,
      speed: length / TRACE_SECONDS,
    },
  };
}
