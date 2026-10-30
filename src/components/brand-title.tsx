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
  const pad = Math.max(18, fontSize * 0.22);
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
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  document.body.appendChild(svg);
  const length = probe.getTotalLength();
  svg.remove();

  return { d, w: width, h: height, length: Math.max(1, length) };
}

function pointAt(path: SVGPathElement, distance: number) {
  const point = path.getPointAtLength(distance);
  return { x: point.x, y: point.y };
}

export function BrandTitle() {
  const inkRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<SVGPathElement>(null);
  const beadRef = useRef<HTMLSpanElement>(null);
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
    const tip = tipRef.current;
    const bead = beadRef.current;
    if (!ink || !tip || !bead || !frame) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ink.style.strokeDasharray = "none";
      ink.style.strokeDashoffset = "0";
      tip.style.opacity = "0";
      bead.style.opacity = "0";
      return;
    }

    let cancelled = false;
    const spring = "cubic-bezier(0.34, 1.56, 0.64, 1)";
    const length = frame.length;
    const tipSize = Math.max(22, Math.round(length * 0.02));

    ink.style.strokeDasharray = `${length}`;
    tip.style.strokeDasharray = `${tipSize} ${length}`;

    const run = async () => {
      while (!cancelled) {
        const start = pointAt(ink, 0);
        const end = pointAt(ink, length);

        ink.getAnimations().forEach((animation) => animation.cancel());
        tip.getAnimations().forEach((animation) => animation.cancel());
        bead.getAnimations().forEach((animation) => animation.cancel());

        ink.style.strokeDashoffset = `${length}`;
        tip.style.strokeDashoffset = `${length}`;
        ink.style.opacity = "1";
        tip.style.opacity = "1";
        bead.style.opacity = "0";
        bead.style.transform = `translate(${start.x}px, ${start.y}px) scale(1)`;

        const drawMs = Math.min(6400, Math.max(3600, length * 1.45));
        const draw = ink.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
          duration: drawMs,
          easing: "linear",
          fill: "forwards",
        });
        const tipDraw = tip.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
          duration: drawMs,
          easing: "linear",
          fill: "forwards",
        });
        await Promise.all([draw.finished.catch(() => undefined), tipDraw.finished.catch(() => undefined)]);
        if (cancelled) return;

        tip.style.opacity = "0";
        bead.style.opacity = "1";
        bead.style.transform = `translate(${end.x}px, ${end.y}px) scale(1)`;

        const bounce = bead.animate(
          [
            { transform: `translate(${end.x}px, ${end.y}px) scale(1)`, opacity: 1, offset: 0 },
            {
              transform: `translate(${end.x + 20}px, ${end.y - 28}px) scale(1.45)`,
              opacity: 1,
              offset: 0.4,
            },
            {
              transform: `translate(${end.x + 46}px, ${end.y - 62}px) scale(0.4)`,
              opacity: 0,
              offset: 1,
            },
          ],
          { duration: 600, easing: spring, fill: "forwards" },
        );
        await bounce.finished.catch(() => undefined);
        if (cancelled) return;

        const fadeInk = ink.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 260,
          fill: "forwards",
          easing: "ease-out",
        });
        await fadeInk.finished.catch(() => undefined);
        if (cancelled) return;

        ink.getAnimations().forEach((animation) => animation.cancel());
        ink.style.strokeDashoffset = `${length}`;
        tip.style.strokeDashoffset = `${length}`;
        ink.style.opacity = "1";
        tip.style.opacity = "0";

        const land = bead.animate(
          [
            { transform: `translate(${start.x}px, ${start.y - 28}px) scale(0.3)`, opacity: 0, offset: 0 },
            { transform: `translate(${start.x}px, ${start.y + 4}px) scale(1.2)`, opacity: 1, offset: 0.6 },
            { transform: `translate(${start.x}px, ${start.y}px) scale(1)`, opacity: 1, offset: 1 },
          ],
          { duration: 520, easing: spring, fill: "forwards" },
        );
        await land.finished.catch(() => undefined);
        if (cancelled) return;

        bead.style.opacity = "0";
        tip.style.opacity = "1";
      }
    };

    void run();
    return () => {
      cancelled = true;
      ink.getAnimations().forEach((animation) => animation.cancel());
      tip.getAnimations().forEach((animation) => animation.cancel());
      bead.getAnimations().forEach((animation) => animation.cancel());
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
          <filter id="brand-ink-glow" x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="1.35" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="brand-tip-glow" x="-90%" y="-90%" width="280%" height="280%">
            <feGaussianBlur stdDeviation="2.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d={frame.d} className="brand-wordmark-fill" />
        <path ref={inkRef} d={frame.d} className="brand-wordmark-ink" filter="url(#brand-ink-glow)" />
        <path ref={tipRef} d={frame.d} className="brand-wordmark-tip" filter="url(#brand-tip-glow)" />
      </svg>
      <span ref={beadRef} className="brand-trace-bead" aria-hidden="true" />
    </span>
  );
}
