import { useEffect, useRef, useState } from "react";

type GlyphFrame = {
  d: string;
  w: number;
  h: number;
  length: number;
  scale: number;
};

type BrandFont = {
  getPath: (
    text: string,
    x: number,
    y: number,
    fontSize: number,
  ) => {
    getBoundingBox: () => { x1: number; y1: number; x2: number; y2: number };
    toPathData: (decimalPlaces: number) => string;
  };
};

const WORD = "Clipkeep";
const FONT_URL = "/fonts/Fraunces-Italic.ttf";

let fontPromise: Promise<BrandFont> | null = null;

async function loadBrandFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const mod = await import("opentype.js");
      const parse =
        (mod as { parse?: (buffer: ArrayBuffer) => BrandFont }).parse ??
        (mod as { default?: { parse: (buffer: ArrayBuffer) => BrandFont } }).default?.parse;
      if (!parse) throw new Error("opentype.parse unavailable");
      const response = await fetch(FONT_URL);
      if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
      return parse(await response.arrayBuffer());
    })();
  }
  return fontPromise;
}

function buildGlyphFrame(font: BrandFont, fontSize: number): GlyphFrame {
  const path = font.getPath(WORD, 0, 0, fontSize);
  const box = path.getBoundingBox();
  const pad = Math.max(16, fontSize * 0.18);
  const shiftX = pad - box.x1;
  const shiftY = pad - box.y1;
  const shifted = font.getPath(WORD, shiftX, shiftY, fontSize);
  // Variable-font paths can emit NaN at some sizes; scrub before measuring/rendering.
  const d = shifted.toPathData(2).replace(/-?NaN/gi, "0");
  const width = Math.ceil(box.x2 - box.x1 + pad * 2);
  const height = Math.ceil(box.y2 - box.y1 + pad * 2);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "path");
  probe.setAttribute("d", d);
  svg.appendChild(probe);
  svg.style.cssText = "position:absolute;visibility:hidden;width:0;height:0";
  document.body.appendChild(svg);
  const length = probe.getTotalLength();
  svg.remove();

  return { d, w: width, h: height, length: Math.max(1, length), scale: 1 };
}

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

export function BrandTitle() {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const slimeRef = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState<GlyphFrame | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        const font = await loadBrandFont();
        if (cancelled) return;
        // Build at 60 — some VF sizes emit NaN commands; scale the SVG for mobile.
        const base = buildGlyphFrame(font, 60);
        const scale = window.matchMedia("(min-width: 640px)").matches ? 1 : 48 / 60;
        setFrame({ ...base, scale });
      } catch {
        if (!cancelled) setFrame(null);
      }
    };

    void render();
    const onResize = () => void render();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    const slime = slimeRef.current;
    if (!svg || !path || !slime || !frame) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      slime.style.opacity = "0";
      return;
    }

    let cancelled = false;
    let raf = 0;
    const length = frame.length;
    // Slow, calm outline lap.
    const traceMs = Math.min(14000, Math.max(9000, length * 4.2));
    const floatMs = 1600;

    const toScreen = (localX: number, localY: number) => {
      const ctm = path.getScreenCTM();
      if (!ctm) {
        const box = svg.getBoundingClientRect();
        return { x: box.left + localX, y: box.top + localY };
      }
      return {
        x: ctm.a * localX + ctm.c * localY + ctm.e,
        y: ctm.b * localX + ctm.d * localY + ctm.f,
      };
    };

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
      slime.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotating}deg) scale(${scale * stretchX}, ${scale * stretchY})`;
    };

    const placeOnPath = (distance: number, extra: Parameters<typeof placeSlime>[2] = {}) => {
      const point = pointAt(path, distance);
      const screen = toScreen(point.x, point.y);
      placeSlime(screen.x, screen.y, extra);
    };

    const floatCorner = () => {
      const margin = 28;
      return {
        x: Math.max(margin, window.innerWidth - margin - 10),
        y: margin + 8,
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
      while (!cancelled) {
        // Slow slime outline around Clipkeep.
        await animate(traceMs, (t) => {
          const progress = t; // steady crawl feels more “tracing”
          const wobble = 1 + Math.sin(t * Math.PI * 10) * 0.06;
          placeOnPath(length * progress, {
            scale: wobble,
            stretchX: 1 + Math.sin(t * Math.PI * 7) * 0.12,
            stretchY: 1 - Math.sin(t * Math.PI * 7) * 0.1,
            rotating: Math.sin(t * Math.PI * 6) * 18,
          });
        });
        if (cancelled) return;

        const endLocal = pointAt(path, length);
        const end = toScreen(endLocal.x, endLocal.y);
        const corner = floatCorner();

        // Slime stretch-jump to the top-right.
        await animate(720, (t) => {
          const p = easeInOutCubic(t);
          const x = lerp(end.x, corner.x, p);
          const y = lerp(end.y, corner.y, p) - Math.sin(p * Math.PI) * 42;
          const stretchX = 1 + Math.sin(p * Math.PI) * 1.35;
          const stretchY = 1 - Math.sin(p * Math.PI) * 0.45;
          placeSlime(x, y, {
            scale: lerp(1, 1.15, Math.sin(p * Math.PI)),
            stretchX,
            stretchY,
            rotating: lerp(0, 120, p),
            opacity: 1,
          });
        });
        if (cancelled) return;

        // Float / jiggle in the corner for ~1.6s.
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

        const startLocal = pointAt(path, 0);
        const start = toScreen(startLocal.x, startLocal.y);

        // Slime jumps back onto the first letter.
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

        // Soft settle onto the path before the next slow outline.
        await animate(320, (t) => {
          const p = smootherstep(t);
          placeOnPath(0, {
            scale: lerp(1.2, 1, p),
            stretchX: lerp(1.25, 1, p),
            stretchY: lerp(0.85, 1, p),
            rotating: lerp(-12, 0, p),
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

  if (!frame) {
    return (
      <span className="brand-title brand-title-fallback font-display text-5xl font-semibold italic tracking-[-0.04em] sm:text-6xl">
        Clipkeep
      </span>
    );
  }

  const displayW = Math.round(frame.w * frame.scale);
  const displayH = Math.round(frame.h * frame.scale);

  return (
    <span className="brand-title" style={{ width: displayW, height: displayH }}>
      <svg
        ref={svgRef}
        className="brand-wordmark"
        width={displayW}
        height={displayH}
        viewBox={`0 0 ${frame.w} ${frame.h}`}
        role="img"
        aria-label="Clipkeep"
      >
        <title>Clipkeep</title>
        <path d={frame.d} className="brand-wordmark-fill" />
        {/* Invisible path used only for slime tracing math. */}
        <path ref={pathRef} d={frame.d} className="brand-wordmark-trace" />
      </svg>
      <span ref={slimeRef} className="brand-slime" aria-hidden="true" />
    </span>
  );
}
