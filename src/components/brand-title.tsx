import { useEffect, useRef, useState } from "react";

type GlyphFrame = {
  d: string;
  w: number;
  h: number;
  length: number;
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
  const pad = Math.max(20, fontSize * 0.24);
  const shiftX = pad - box.x1;
  const shiftY = pad - box.y1;
  const shifted = font.getPath(WORD, shiftX, shiftY, fontSize);
  const d = shifted.toPathData(2);
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

  return { d, w: width, h: height, length: Math.max(1, length) };
}

function smootherstep(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number) {
  const c1 = 1.40158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pointAt(path: SVGPathElement, distance: number) {
  const clamped = Math.min(path.getTotalLength(), Math.max(0, distance));
  const point = path.getPointAtLength(clamped);
  return { x: point.x, y: point.y };
}

export function BrandTitle() {
  const inkRef = useRef<SVGPathElement>(null);
  const wakeRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<SVGPathElement>(null);
  const beadRef = useRef<HTMLSpanElement>(null);
  const softRef = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState<GlyphFrame | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        const font = await loadBrandFont();
        if (cancelled) return;
        const size = window.matchMedia("(min-width: 640px)").matches ? 60 : 48;
        setFrame(buildGlyphFrame(font, size));
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
    const ink = inkRef.current;
    const wake = wakeRef.current;
    const tip = tipRef.current;
    const bead = beadRef.current;
    const soft = softRef.current;
    if (!ink || !wake || !tip || !bead || !soft || !frame) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ink.style.strokeDasharray = "none";
      ink.style.strokeDashoffset = "0";
      wake.style.opacity = "0";
      tip.style.opacity = "0";
      bead.style.opacity = "0";
      soft.style.opacity = "0";
      return;
    }

    let cancelled = false;
    let raf = 0;
    const length = frame.length;
    const tipLen = Math.max(28, length * 0.028);
    const wakeLen = Math.max(70, length * 0.08);
    const drawMs = Math.min(9000, Math.max(6200, length * 2.4));

    ink.style.strokeDasharray = `${length}`;
    wake.style.strokeDasharray = `${wakeLen} ${length}`;
    tip.style.strokeDasharray = `${tipLen} ${length}`;

    const setHead = (distance: number, opacity = 1, scale = 1) => {
      const { x, y } = pointAt(ink, distance);
      const transform = `translate(${x}px, ${y}px) scale(${scale})`;
      bead.style.transform = transform;
      soft.style.transform = `translate(${x}px, ${y}px) scale(${scale * 1.85})`;
      bead.style.opacity = String(opacity);
      soft.style.opacity = String(opacity * 0.55);
    };

    const setStrokeProgress = (progress: number) => {
      const drawn = length * progress;
      const offset = length - drawn;
      ink.style.strokeDashoffset = `${offset}`;
      wake.style.strokeDashoffset = `${offset}`;
      tip.style.strokeDashoffset = `${offset}`;
      setHead(drawn, 1, 1);
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
        ink.style.opacity = "1";
        wake.style.opacity = "1";
        tip.style.opacity = "1";

        await animate(drawMs, (t) => {
          const progress = smootherstep(t);
          setStrokeProgress(progress);
        });
        if (cancelled) return;

        tip.style.opacity = "0";
        wake.style.opacity = "0";
        const end = pointAt(ink, length);
        const startPt = pointAt(ink, 0);

        await animate(780, (t) => {
          const p = easeOutCubic(t);
          const x = lerp(end.x, end.x + 38, p);
          const y = lerp(end.y, end.y - 54, p) - Math.sin(p * Math.PI) * 10;
          const scale = lerp(1, 0.35, p);
          const opacity = 1 - smootherstep(Math.max(0, (t - 0.35) / 0.65));
          const transform = `translate(${x}px, ${y}px) scale(${scale})`;
          bead.style.transform = transform;
          soft.style.transform = `translate(${x}px, ${y}px) scale(${scale * 2.1})`;
          bead.style.opacity = String(opacity);
          soft.style.opacity = String(opacity * 0.45);
        });
        if (cancelled) return;

        await animate(520, (t) => {
          ink.style.opacity = String(1 - smootherstep(t));
        });
        if (cancelled) return;

        ink.style.strokeDashoffset = `${length}`;
        wake.style.strokeDashoffset = `${length}`;
        tip.style.strokeDashoffset = `${length}`;
        ink.style.opacity = "0";

        await animate(680, (t) => {
          const p = easeOutBack(Math.min(1, t * 1.02));
          const x = startPt.x;
          const y = lerp(startPt.y - 34, startPt.y, Math.min(1, p));
          const scale = lerp(0.25, 1, Math.min(1, p));
          const opacity = smootherstep(Math.min(1, t * 1.15));
          ink.style.opacity = String(smootherstep(Math.max(0, (t - 0.45) / 0.55)));
          const transform = `translate(${x}px, ${y}px) scale(${scale})`;
          bead.style.transform = transform;
          soft.style.transform = `translate(${x}px, ${y}px) scale(${scale * 1.9})`;
          bead.style.opacity = String(opacity);
          soft.style.opacity = String(opacity * 0.5);
        });
        if (cancelled) return;

        ink.style.opacity = "1";
        wake.style.opacity = "1";
        tip.style.opacity = "1";
        setStrokeProgress(0);
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

  return (
    <span className="brand-title" style={{ width: frame.w, height: frame.h }}>
      <svg
        className="brand-wordmark"
        width={frame.w}
        height={frame.h}
        viewBox={`0 0 ${frame.w} ${frame.h}`}
        role="img"
        aria-label="Clipkeep"
      >
        <title>Clipkeep</title>
        <defs>
          <filter id="brand-ink-glow" x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="1.8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="brand-wake-glow" x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="brand-tip-glow" x="-120%" y="-120%" width="340%" height="340%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.4" result="blur" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="tight" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="tight" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d={frame.d} className="brand-wordmark-fill" />
        <path ref={inkRef} d={frame.d} className="brand-wordmark-ink" filter="url(#brand-ink-glow)" />
        <path ref={wakeRef} d={frame.d} className="brand-wordmark-wake" filter="url(#brand-wake-glow)" />
        <path ref={tipRef} d={frame.d} className="brand-wordmark-tip" filter="url(#brand-tip-glow)" />
      </svg>
      <span ref={softRef} className="brand-trace-bead brand-trace-bead-soft" aria-hidden="true" />
      <span ref={beadRef} className="brand-trace-bead" aria-hidden="true" />
    </span>
  );
}
