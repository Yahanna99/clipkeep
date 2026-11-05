import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DESKTOP_FONT_SIZE,
  MOBILE_FONT_SIZE,
  WORD,
  advanceSim,
  blobPixelSize,
  blobSvg,
  buildBrandFrame,
  createSim,
  poseOf,
  randomPlayMs,
  splatOffsets,
  type BrandFont,
  type BrandFrame,
} from "@/lib/brand/slime";

let fontPromise: Promise<BrandFont> | null = null;

function loadFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const mod = await import("opentype.js");
      const parse =
        (mod as { parse?: (buffer: ArrayBuffer) => BrandFont }).parse ??
        (mod as { default?: { parse: (buffer: ArrayBuffer) => BrandFont } }).default?.parse;
      if (!parse) throw new Error("opentype.parse unavailable");
      const response = await fetch("/fonts/TitanOne-Regular.ttf");
      if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
      return parse(await response.arrayBuffer());
    })().catch((error) => {
      fontPromise = null;
      throw error;
    });
  }
  return fontPromise;
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Bake the goo filter once so the crawling blob can move as a single GPU layer. */
async function rasterizeBlob(svg: string, size: number) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("slime svg"));
      image.src = url;
    });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return svgDataUrl(svg);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let alpha = 0;
    for (let i = 3; i < pixels.length; i += 64) if (pixels[i] > alpha) alpha = pixels[i];
    if (alpha < 12) return svgDataUrl(svg);
    return canvas.toDataURL("image/png");
  } catch {
    return svgDataUrl(svg);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dampAngle(current: number, target: number, dt: number) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-dt / 42));
}

export function BrandTitle() {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const slimeRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(1);
  const [desktop, setDesktop] = useState(true);
  const [frame, setFrame] = useState<BrandFrame | null>(null);
  const [fit, setFit] = useState(1);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const apply = () => setDesktop(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fontSize = desktop ? DESKTOP_FONT_SIZE : MOBILE_FONT_SIZE;
    void (async () => {
      try {
        const font = await loadFont();
        if (cancelled) return;
        const next = buildBrandFrame(font, fontSize);
        const baked = blobSvg(fontSize);
        const url = await rasterizeBlob(baked.svg, baked.size);
        if (cancelled) return;
        setFrame(next);
        setBlobUrl(url);
      } catch {
        if (!cancelled) {
          setFrame(null);
          setBlobUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !frame) return;
    const lockup = wrap.closest(".brand-lockup");
    const host = lockup?.parentElement;
    if (!lockup || !host) return;

    const measure = () => {
      const logo = lockup.querySelector(".mark-wrap");
      const logoW = logo instanceof HTMLElement ? logo.offsetWidth : 0;
      const styles = getComputedStyle(lockup);
      const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
      const available = host.clientWidth - logoW - gap;
      const next = available > 48 ? Math.min(1, (available - 4) / frame.w) : 1;
      fitRef.current = next;
      setFit((prev) => (Math.abs(prev - next) < 0.012 ? prev : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [frame]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const slime = slimeRef.current;
    if (!wrap || !slime || !frame || !blobUrl) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) {
      wrap.dataset.slimePhase = "still";
      slime.style.opacity = "0";
      return;
    }

    const drops = [...slime.querySelectorAll<HTMLElement>(".brand-drop")];
    const blobSize = blobPixelSize(frame.fontSize);
    let appliedFit = -1;
    let angle = 0;
    let dropsLive = false;
    let phase = "";
    let sim = createSim(randomPlayMs());
    let last = performance.now();
    let raf = 0;
    let stopped = false;

    const hideDrops = () => {
      if (!dropsLive) return;
      dropsLive = false;
      for (const drop of drops) drop.style.transform = "translate(-50%, -50%) scale(0)";
    };

    const tick = (now: number) => {
      if (stopped) return;
      const dt = Math.min(34, now - last);
      last = now;
      const s = fitRef.current;
      if (s !== appliedFit) {
        appliedFit = s;
        const px = blobSize * s;
        slime.style.width = `${px}px`;
        slime.style.height = `${px}px`;
      }
      sim = advanceSim(sim, frame.track, dt, {
        launchTarget: (from) => {
          const rect = wrap.getBoundingClientRect();
          const fontSize = frame.fontSize * s;
          let x = rect.left + from.x * s - fontSize * 0.12;
          let y = rect.top + from.y * s - fontSize * 1.45;
          const pad = fontSize * 0.95;
          x = Math.min(window.innerWidth - pad, Math.max(pad, x));
          y = Math.min(window.innerHeight - pad, Math.max(pad, y));
          return {
            x: (x - rect.left) / s,
            y: (y - rect.top) / s,
            arc: frame.fontSize * 0.32,
            wobble: frame.fontSize * 0.09,
          };
        },
        nextPlayMs: () => randomPlayMs(),
      });
      const pose = poseOf(sim, frame.track, now);
      angle = dampAngle(angle, Math.atan2(pose.ty, pose.tx), dt);
      const half = (blobSize * s) / 2;
      slime.style.opacity = "1";
      slime.style.transform = `translate3d(${(pose.x * s - half).toFixed(2)}px, ${(pose.y * s - half).toFixed(2)}px, 0) rotate(${angle.toFixed(4)}rad) scale(${pose.sx.toFixed(3)}, ${pose.sy.toFixed(3)})`;
      if (sim.phase !== phase) {
        phase = sim.phase;
        wrap.dataset.slimePhase = phase;
      }
      if (pose.burst > 0.04) {
        dropsLive = true;
        const parts = splatOffsets(pose.burst, now, frame.fontSize * s);
        drops.forEach((drop, index) => {
          const part = parts[index];
          if (!part) return;
          drop.style.transform = `translate(-50%, -50%) translate(${part.x.toFixed(2)}px, ${part.y.toFixed(2)}px) scale(${part.scale.toFixed(3)})`;
        });
      } else {
        hideDrops();
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    const onMotion = () => {
      if (!motion.matches) return;
      stopped = true;
      cancelAnimationFrame(raf);
      wrap.dataset.slimePhase = "still";
      slime.style.opacity = "0";
    };
    motion.addEventListener("change", onMotion);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      motion.removeEventListener("change", onMotion);
    };
  }, [frame, blobUrl]);

  return (
    <span
      ref={wrapRef}
      className="brand-title"
      data-slime-phase={frame ? undefined : "loading"}
      style={frame ? { width: Math.round(frame.w * fit), height: Math.round(frame.h * fit) } : undefined}
    >
      {frame ? (
        <svg
          className="brand-wordmark"
          viewBox={`0 0 ${frame.w} ${frame.h}`}
          width="100%"
          height="100%"
          role="img"
          aria-label={WORD}
        >
          <title>{WORD}</title>
          <path d={frame.d} className="brand-wordmark-fill" />
        </svg>
      ) : (
        <span className="brand-title-text">{WORD}</span>
      )}
      <div ref={slimeRef} className="brand-slime" aria-hidden="true">
        {blobUrl ? <img src={blobUrl} alt="" draggable={false} /> : null}
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} className="brand-drop" />
        ))}
      </div>
    </span>
  );
}
