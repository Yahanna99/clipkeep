import { useEffect, useLayoutEffect, useRef, useState } from "react";

const WORD = "Clipkeep";

type TraceFrame = {
  d: string;
  length: number;
  width: number;
  height: number;
};

function smootherstep(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pointAt(path: SVGPathElement, distance: number) {
  const clamped = Math.min(path.getTotalLength(), Math.max(0, distance));
  return path.getPointAtLength(clamped);
}

type LetterBox = { x: number; y: number; w: number; h: number };

/**
 * One continuous outline around the word: along letter tops L→R,
 * down the last letter, along bottoms R→L, back up the first.
 * Uses real glyph boxes so the slime stays glued to Clipkeep.
 */
function wordOutlinePath(letters: LetterBox[]): string {
  if (!letters.length) return "";
  const top = letters.map((letter) => ({
    x: letter.x + letter.w / 2,
    y: letter.y,
  }));
  const bottom = letters.map((letter) => ({
    x: letter.x + letter.w / 2,
    y: letter.y + letter.h,
  }));
  const first = letters[0];
  const last = letters[letters.length - 1];
  const pts = [
    { x: first.x, y: first.y + first.h * 0.55 },
    { x: first.x, y: first.y },
    ...top,
    { x: last.x + last.w, y: last.y },
    { x: last.x + last.w, y: last.y + last.h * 0.55 },
    { x: last.x + last.w, y: last.y + last.h },
    ...bottom.reverse(),
    { x: first.x, y: first.y + first.h },
    { x: first.x, y: first.y + first.h * 0.55 },
  ];

  // Smooth through the silhouette with quadratic midpoints.
  let d = `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const curr = pts[i];
    const next = pts[i + 1];
    const mx = (curr.x + next.x) / 2;
    const my = (curr.y + next.y) / 2;
    d += ` Q${curr.x.toFixed(2)} ${curr.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const end = pts[pts.length - 1];
  d += ` T${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
  return d;
}

function buildTraceFromText(textEl: HTMLElement): TraceFrame | null {
  const textNode = [...textEl.childNodes].find(
    (node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0,
  );
  if (!textNode) return null;

  const origin = textEl.getBoundingClientRect();
  if (origin.width < 8 || origin.height < 8) return null;

  const pad = 1.5;
  const letters: LetterBox[] = [];
  for (let index = 0; index < WORD.length; index += 1) {
    const range = document.createRange();
    range.setStart(textNode, index);
    range.setEnd(textNode, index + 1);
    const rect = range.getBoundingClientRect();
    range.detach();
    if (rect.width < 1 || rect.height < 1) continue;
    letters.push({
      x: rect.left - origin.left - pad,
      y: rect.top - origin.top - pad,
      w: rect.width + pad * 2,
      h: rect.height + pad * 2,
    });
  }
  if (!letters.length) return null;

  const d = wordOutlinePath(letters);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "path");
  probe.setAttribute("d", d);
  svg.appendChild(probe);
  svg.style.cssText = "position:absolute;visibility:hidden;width:0;height:0";
  document.body.appendChild(svg);
  const length = probe.getTotalLength();
  svg.remove();

  return {
    d,
    length: Math.max(1, length),
    width: origin.width,
    height: origin.height,
  };
}

export function BrandTitle() {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const slimeRef = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState<TraceFrame | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const textEl = textRef.current;
    if (!textEl) return;

    const measure = async () => {
      try {
        await document.fonts.ready;
        if (cancelled) return;
        // One frame after fonts so italic metrics settle.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (cancelled) return;
        const next = buildTraceFromText(textEl);
        if (!cancelled) setFrame(next);
      } catch {
        if (!cancelled) setFrame(null);
      }
    };

    void measure();
    const onResize = () => void measure();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const path = pathRef.current;
    const slime = slimeRef.current;
    if (!wrap || !path || !slime || !frame) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      slime.style.opacity = "0";
      return;
    }

    let cancelled = false;
    let raf = 0;
    const length = frame.length;
    const traceMs = Math.min(12000, Math.max(7800, length * 3.8));
    const floatMs = 1600;

    const placeSlime = (
      x: number,
      y: number,
      opts: { scale?: number; stretchX?: number; stretchY?: number; opacity?: number; rotating?: number } = {},
    ) => {
      const scale = opts.scale ?? 1;
      const stretchX = opts.stretchX ?? 1;
      const stretchY = opts.stretchY ?? 1;
      const opacity = opts.opacity ?? 1;
      const rotating = opts.rotating ?? 0;
      slime.style.opacity = String(opacity);
      // Coordinates are local to the title wrapper (position: absolute).
      slime.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotating}deg) scale(${scale * stretchX}, ${scale * stretchY})`;
    };

    const placeOnPath = (distance: number, extra: Parameters<typeof placeSlime>[2] = {}) => {
      const point = pointAt(path, distance);
      placeSlime(point.x, point.y, extra);
    };

    const floatCornerLocal = () => {
      const wrapBox = wrap.getBoundingClientRect();
      const margin = 28;
      return {
        x: Math.max(wrapBox.width + 24, window.innerWidth - margin - wrapBox.left - 10),
        y: Math.min(-wrapBox.top + margin + 8, -12),
      };
    };

    const animate = (duration: number, tick: (t: number) => void) =>
      new Promise<void>((resolve) => {
        const start = performance.now();
        const step = (now: number) => {
          if (cancelled) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - start) / duration);
          tick(t);
          if (t < 1) raf = requestAnimationFrame(step);
          else resolve();
        };
        raf = requestAnimationFrame(step);
      });

    const run = async () => {
      // Start visible on the first letter.
      placeOnPath(0, { opacity: 1 });

      while (!cancelled) {
        await animate(traceMs, (t) => {
          const wobble = 1 + Math.sin(t * Math.PI * 10) * 0.06;
          placeOnPath(length * t, {
            scale: wobble,
            stretchX: 1 + Math.sin(t * Math.PI * 7) * 0.12,
            stretchY: 1 - Math.sin(t * Math.PI * 7) * 0.1,
            rotating: Math.sin(t * Math.PI * 6) * 18,
            opacity: 1,
          });
        });
        if (cancelled) return;

        const end = pointAt(path, length);
        const corner = floatCornerLocal();

        await animate(720, (t) => {
          const p = easeInOutCubic(t);
          const x = lerp(end.x, corner.x, p);
          const y = lerp(end.y, corner.y, p) - Math.sin(p * Math.PI) * 42;
          placeSlime(x, y, {
            scale: lerp(1, 1.15, Math.sin(p * Math.PI)),
            stretchX: 1 + Math.sin(p * Math.PI) * 1.35,
            stretchY: 1 - Math.sin(p * Math.PI) * 0.45,
            rotating: lerp(0, 120, p),
            opacity: 1,
          });
        });
        if (cancelled) return;

        await animate(floatMs, (t) => {
          const bob = Math.sin(t * Math.PI * 3) * 7;
          const sway = Math.cos(t * Math.PI * 2.2) * 5;
          placeSlime(corner.x + sway, corner.y + bob, {
            scale: 1.08 + Math.sin(t * Math.PI * 4) * 0.08,
            stretchX: 1 + Math.sin(t * Math.PI * 5) * 0.22,
            stretchY: 1 - Math.sin(t * Math.PI * 5) * 0.16,
            rotating: Math.sin(t * Math.PI * 3) * 24,
            opacity: 1,
          });
        });
        if (cancelled) return;

        const start = pointAt(path, 0);
        await animate(780, (t) => {
          const p = easeOutCubic(t);
          const x = lerp(corner.x, start.x, p);
          const y = lerp(corner.y, start.y, p) - Math.sin(p * Math.PI) * 36;
          placeSlime(x, y, {
            scale: lerp(1.1, 1, p),
            stretchX: 1 + Math.sin(p * Math.PI) * 1.1,
            stretchY: 1 - Math.sin(p * Math.PI) * 0.4,
            rotating: lerp(20, 0, p),
            opacity: 1,
          });
        });
        if (cancelled) return;

        await animate(320, (t) => {
          const p = smootherstep(t);
          placeOnPath(0, {
            scale: lerp(1.2, 1, p),
            stretchX: lerp(1.25, 1, p),
            stretchY: lerp(0.85, 1, p),
            rotating: lerp(-12, 0, p),
            opacity: 1,
          });
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [frame]);

  return (
    <span ref={wrapRef} className="brand-title">
      <span
        ref={textRef}
        className="brand-title-text font-display text-5xl font-semibold italic leading-[1.02] tracking-[-0.04em] sm:text-6xl"
      >
        {WORD}
      </span>
      {frame ? (
        <svg className="brand-trace" width={frame.width} height={frame.height} aria-hidden="true">
          <path ref={pathRef} d={frame.d} className="brand-trace-path" />
        </svg>
      ) : null}
      <span ref={slimeRef} className="brand-slime" aria-hidden="true" />
    </span>
  );
}
