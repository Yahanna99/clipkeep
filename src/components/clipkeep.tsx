import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardPaste, Download, ExternalLink, Loader2, X } from "lucide-react";
import { toast, Toaster } from "sonner";
import { extractPostUrl, isConcretePost, isRedditHost, platformOf, slug } from "@/lib/clip/links";
import { stampMp4Times } from "@/lib/clip/mp4";
import { mapStaggered } from "@/lib/clip/pool";
import { resolveClip } from "@/lib/clip/resolve";
import type { ClipMedia, Platform, Variant } from "@/lib/clip/types";

const HISTORY_KEY = "clipkeep.history.v1";

const SAMPLES: { label: string; platform: Platform; url: string }[] = [
  { label: "NASA on X", platform: "x", url: "https://x.com/NASA/status/2039473910987534599" },
  {
    label: "TikTok video",
    platform: "tiktok",
    url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
  },
  {
    label: "Instagram reel",
    platform: "instagram",
    url: "https://www.instagram.com/reel/DElF5QjSGd2/",
  },
  {
    label: "TikTok photos",
    platform: "tiktok",
    url: "https://www.tiktok.com/@mens.guidance/photo/7467226363544554770",
  },
];

type HistoryItem = {
  id: string;
  platform: Platform;
  title: string;
  author: string;
  thumbnail?: string;
  sourceUrl: string;
  savedAt: number;
};

type ReadyFile = { file: File; files: File[]; url: string };

function platformName(platform: Platform): string {
  if (platform === "tiktok") return "TikTok";
  if (platform === "instagram") return "Instagram";
  return "X";
}

function imagesOf(media: ClipMedia): Variant[] {
  return media.variants.filter((variant) => variant.kind === "image");
}

function videosOf(media: ClipMedia): Variant[] {
  return media.variants.filter((variant) => variant.kind === "video");
}

function audiosOf(media: ClipMedia): Variant[] {
  return media.variants.filter((variant) => variant.kind === "audio");
}

function videoGroups(media: ClipMedia): Variant[][] {
  const groups = new Map<string, Variant[]>();
  for (const variant of videosOf(media)) {
    const key = variant.group || variant.id;
    const list = groups.get(key);
    if (list) list.push(variant);
    else groups.set(key, [variant]);
  }
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)),
  );
}

function bestVariant(media: ClipMedia): Variant {
  const groups = videoGroups(media);
  const photos = imagesOf(media);
  // Multi-still posts (Instagram carousels / TikTok photos): open the gallery first.
  if (photos.length > 1) return photos[0];
  if (groups.length && photos.length) return groups[0][0];
  if (photos.length) return photos[0];
  if (groups.length) return groups[0][0];
  return media.variants[0];
}

function fileName(media: ClipMedia, variant: Variant): string {
  const who = slug(media.authorHandle || media.author, "clipkeep");
  const what = slug(media.title, variant.kind);
  if (variant.kind === "image") {
    return `${who}-${what}-${String(variant.index ?? 1).padStart(2, "0")}.${variant.ext}`;
  }
  return `${who}-${what}.${variant.ext}`;
}

function proxyUrl(url: string, name: string, download = false): string {
  const params = new URLSearchParams({ u: url, n: name });
  if (download) params.set("dl", "1");
  return `/api/file?${params.toString()}`;
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            item &&
            typeof item.sourceUrl === "string" &&
            typeof item.title === "string" &&
            (item.platform === "tiktok" || item.platform === "instagram" || item.platform === "x"),
        )
      : [];
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 24)));
  } catch {
    /* storage can be full or blocked */
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "Couldn’t read that link.";
  return message.replace(/^.*?Error:\s*/, "");
}

function retryable(message: string): boolean {
  return !/isn’t TikTok|full https|too long|Paste a|private|cut off|won’t save|doesn’t save|doesn’t have|rate-limiting/i.test(
    message,
  );
}

const BACKOFF_MS = [800, 1600, 3200];

class DownloadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DownloadError";
    this.status = status;
  }
}

function failureMessage(status: number, offline: boolean): string {
  if (offline || status === 0) return "Connection dropped. Check your connection and retry.";
  if (status === 429) return "Instagram is rate-limiting us right now. Wait a minute and try again.";
  if (status === 403 || status === 410) return "This link expired. Trying a fresh copy…";
  return "Couldn’t prepare that file. Tap Save to try again.";
}

async function fetchWithRetry(url: string): Promise<Response> {
  let status = 0;
  let offline = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      offline = true;
      status = 0;
      continue;
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      status = response.status;
      offline = false;
      await response.body?.cancel().catch(() => undefined);
      if (status === 403 || status === 410) break;
    } catch {
      status = 0;
      offline = true;
    }
  }
  throw new DownloadError(status, failureMessage(status, offline || status === 0));
}

function variantMatch(next: ClipMedia, variant: Variant): Variant {
  return (
    next.variants.find((item) => item.id === variant.id) ||
    next.variants.find((item) => item.kind === variant.kind && item.index === variant.index) ||
    next.variants.find((item) => item.kind === variant.kind && item.group === variant.group) ||
    next.variants.find((item) => item.kind === variant.kind) ||
    variant
  );
}

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function mimeFor(variant: Variant, header: string): string {
  const type = header.split(";")[0].trim().toLowerCase();
  if (variant.kind === "image") {
    if (type.startsWith("image/") && type !== "image/webp") return type;
    return "image/jpeg";
  }
  if (variant.kind === "video") return type.startsWith("video/") ? type : "video/mp4";
  return type || (variant.ext === "mp3" ? "audio/mpeg" : "application/octet-stream");
}

async function toJpeg(bytes: Uint8Array, name: string): Promise<File> {
  const blob = new Blob([bytesToBuffer(bytes)], { type: "image/webp" });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn’t convert that photo.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const jpeg = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((file) => (file ? resolve(file) : reject(new Error("Couldn’t convert that photo."))), "image/jpeg", 0.92);
  });
  return new File([jpeg], name.replace(/\.webp$/i, ".jpg"), { type: "image/jpeg", lastModified: Date.now() });
}

function canShareFiles(files: File[]): boolean {
  try {
    return !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
}

function cancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";
  return name === "AbortError" || message.includes("abort") || message.includes("cancel");
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 3988292384 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 4294967295;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 4294967295) >>> 0;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function zipFiles(files: File[], name: string): Promise<File> {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const filename = new TextEncoder().encode(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(filename.length),
      u16(0),
      filename,
      data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(filename.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      filename,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return new File([bytesToBuffer(concat([...locals, centralDir, end]))], name, { type: "application/zip" });
}

function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`text-accent ${className}`} aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="currentColor" opacity="0.08" />
      <rect x="26" y="28" width="48" height="44" rx="4" fill="none" stroke="currentColor" strokeWidth="6" />
      <path d="M38 44 L50 58 L62 44" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function PlatformIcon({ platform, className = "size-4" }: { platform: Platform; className?: string }) {
  if (platform === "tiktok") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path
          fill="currentColor"
          d="M14.5 3.2c.6 2.4 2.2 4.1 4.5 4.6v2.5c-1.5 0-2.9-.5-4.1-1.3v6.6c0 3.4-2.7 6.2-6.2 6.2S2.5 19 2.5 15.6s2.7-6.2 6.2-6.2c.3 0 .7 0 1 .1v2.6c-.3-.1-.7-.2-1-.2-2 0-3.6 1.6-3.6 3.7s1.6 3.7 3.6 3.7 3.6-1.6 3.6-3.7V3.2h2.2Z"
        />
      </svg>
    );
  }
  if (platform === "instagram") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d="M3 4.5h5.3l3.8 5.4L16.8 4.5H21l-6.6 8.4L21 19.5h-5.3l-4.2-5.9-4.7 5.9H3l7-8.8L3 4.5Z" />
    </svg>
  );
}

export function Clipkeep() {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<ClipMedia | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [ready, setReady] = useState<ReadyFile | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saveFault, setSaveFault] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const readyUrl = useRef<string | null>(null);
  const refreshFlight = useRef<Promise<ClipMedia> | null>(null);

  const parsed = extractPostUrl(draft);
  const detected = parsed ? platformOf(parsed) : null;
  const selected = media?.variants.find((variant) => variant.id === selectedId) ?? (media ? bestVariant(media) : null);
  const photos = media ? imagesOf(media) : [];
  const groups = media ? videoGroups(media) : [];
  const selectedGroup = selected?.kind === "video" ? groups.find((group) => group.some((item) => item.id === selected.id)) : null;
  const showKindToggle = (photos.length > 0 && groups.length > 0) || groups.length > 1;
  const photoMode = selected?.kind === "image" && photos.length > 0;
  const selectedPhotos = photos.filter((photo) => picked.includes(photo.id));
  const saveCount = photoMode ? selectedPhotos.length : 1;
  const saveLabel = photoMode ? (saveCount === 1 ? "Save photo" : `Save ${saveCount} photos`) : `Save ${selected?.kind ?? "file"}`;
  const downloadName = media && selected ? fileName(media, selected) : "clipkeep";

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    return () => {
      if (readyUrl.current) URL.revokeObjectURL(readyUrl.current);
    };
  }, []);

  function remember(next: ClipMedia) {
    const items = [
      {
        id: `${Date.now()}`,
        platform: next.platform,
        title: next.title,
        author: next.author,
        thumbnail: next.thumbnail,
        sourceUrl: next.sourceUrl,
        savedAt: Date.now(),
      },
      ...readHistory().filter((item) => item.sourceUrl !== next.sourceUrl),
    ];
    writeHistory(items);
    setHistory(items);
  }

  async function fetchPost(input: string, force = false) {
    const url = extractPostUrl(input);
    if (!url || !isConcretePost(url)) {
      let host = "";
      try {
        host = new URL(input.trim()).hostname;
      } catch {
        host = "";
      }
      setError(
        host && isRedditHost(host)
          ? "Clipkeep doesn’t save Reddit posts. Paste a TikTok, Instagram, or X link."
          : "Paste a TikTok, Instagram, or X link.",
      );
      setStatus("error");
      return;
    }
    if (!force && status === "ready" && media?.sourceUrl === url) return;
    const id = ++requestId.current;
    setDraft(url);
    if (inputRef.current) inputRef.current.value = url;
    setStatus("loading");
    setError(null);
    setMedia(null);
    setSelectedId(null);
    setPicked([]);
    clearReady();
    let message = "Couldn’t read that link.";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (id !== requestId.current) return;
      try {
        const next = await resolveClip({ data: { url } });
        if (id !== requestId.current) return;
        setMedia(next);
        const best = bestVariant(next);
        setSelectedId(best.id);
        setPicked(imagesOf(next).map((photo) => photo.id));
        setPreparing(true);
        setStatus("ready");
        remember(next);
        return;
      } catch (caught) {
        if (id !== requestId.current) return;
        message = errorText(caught);
        if (!retryable(message) || attempt === 2) break;
        await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    if (id === requestId.current) {
      setError(message);
      setStatus("error");
    }
  }

  function clearReady() {
    if (readyUrl.current) URL.revokeObjectURL(readyUrl.current);
    readyUrl.current = null;
    setReady(null);
  }

  const prepareKey = useMemo(() => {
    if (!media || !selected) return "";
    if (photoMode) return `img:${[...picked].sort().join(",")}`;
    return `one:${selected.id}`;
  }, [media, selected, photoMode, picked]);

  useLayoutEffect(() => {
    if (!media || !selected || saveCount === 0) {
      clearReady();
      setPreparing(false);
      return;
    }
    const source = media;
    const targets = photoMode ? selectedPhotos : [selected];
    let cancelledRun = false;
    setPreparing(true);
    setSaveFault(null);
    clearReady();
    (async () => {
      try {
        const files = await mapStaggered(targets, 2, 400, (variant) => downloadFile(source, variant, true));
        if (cancelledRun) return;
        const file =
          files.length === 1
            ? files[0]
            : await zipFiles(files, `${slug(source.authorHandle || source.author, "clipkeep")}-photos.zip`);
        if (cancelledRun) return;
        const url = URL.createObjectURL(file);
        readyUrl.current = url;
        setReady({ file, files, url });
      } catch (error) {
        if (cancelledRun) return;
        const message =
          error instanceof DownloadError ? error.message : errorText(error) || "Couldn’t prepare that file. Tap Save to try again.";
        setSaveFault(message);
        toast(message);
      } finally {
        if (!cancelledRun) setPreparing(false);
      }
    })();
    return () => {
      cancelledRun = true;
    };
    // selectedPhotos is derived from picked, which is in prepareKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepareKey, media?.sourceUrl, attempt]);

  function refreshSource(source: ClipMedia): Promise<ClipMedia> {
    if (refreshFlight.current) return refreshFlight.current;
    toast("This link expired. Trying a fresh copy…");
    const pending = resolveClip({ data: { url: source.sourceUrl, fresh: true } })
      .then((next) => {
        setMedia(next);
        setSelectedId((current) => (current && next.variants.some((item) => item.id === current) ? current : bestVariant(next).id));
        return next;
      })
      .finally(() => {
        if (refreshFlight.current === pending) refreshFlight.current = null;
      });
    refreshFlight.current = pending;
    return pending;
  }

  async function downloadFile(source: ClipMedia, variant: Variant, allowRefresh: boolean): Promise<File> {
    const name = fileName(source, variant);
    try {
      const response = await fetchWithRetry(proxyUrl(variant.url, name));
      const buffer = new Uint8Array(await response.arrayBuffer());
      const typeHeader = response.headers.get("content-type") || "";
      if (variant.kind === "image" && /webp/i.test(typeHeader)) return toJpeg(buffer, name);
      const bytes = variant.kind === "video" ? stampMp4Times(buffer) : buffer;
      return new File([bytesToBuffer(bytes)], name, { type: mimeFor(variant, typeHeader), lastModified: Date.now() });
    } catch (error) {
      const status = error instanceof DownloadError ? error.status : 0;
      if (allowRefresh && (status === 403 || status === 410)) {
        const again = await refreshSource(source);
        const nextVariant = variantMatch(again, variant);
        try {
          return await downloadFile(again, nextVariant, false);
        } catch (againError) {
          if (againError instanceof DownloadError && (againError.status === 403 || againError.status === 410)) {
            throw new DownloadError(againError.status, "Couldn’t prepare that file. Tap Save to try again.");
          }
          throw againError;
        }
      }
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(0, "Connection dropped. Check your connection and retry.");
    }
  }

  function onSaveClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!ready) {
      event.preventDefault();
      if (!preparing && saveCount > 0) setAttempt((value) => value + 1);
      return;
    }
    const shareFiles = ready.files;
    if (shareFiles.length && canShareFiles(shareFiles)) {
      event.preventDefault();
      void navigator
        .share({ files: shareFiles })
        .then(() => {
          toast(shareFiles.length > 1 ? "Tap Save Images to add them to Photos." : "Tap Save Video or Save Image.");
        })
        .catch((caught: unknown) => {
          if (cancelled(caught)) return;
          const href = event.currentTarget.getAttribute("href");
          if (href) window.location.assign(href);
        });
    }
  }

  async function pasteLink() {
    try {
      const text = await navigator.clipboard.readText();
      const url = extractPostUrl(text);
      if (!url || !isConcretePost(url)) {
        setDraft(text.trim());
        if (inputRef.current) inputRef.current.value = text.trim();
        toast(text.trim() ? "Couldn’t find a post link in that paste" : "Clipboard is empty");
        return;
      }
      setDraft(url);
      if (inputRef.current) inputRef.current.value = url;
      void fetchPost(url, true);
    } catch {
      inputRef.current?.focus();
      toast("Paste the link into the field");
    }
  }

  function onInput(value: string) {
    setDraft(value);
    if (status === "error") {
      setStatus("idle");
      setError(null);
    }
    const url = extractPostUrl(value);
    if (url && isConcretePost(url)) void fetchPost(url);
  }

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-bg text-fg">
      <Toaster theme="dark" position="top-center" />
      <div aria-hidden="true" className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-64" />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-16 pt-6 sm:px-6">
        <header className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2.5">
            <Mark />
            <span className="font-display text-xl italic tracking-tight">Clipkeep</span>
          </span>
          <p className="hidden text-xs text-muted sm:block">Photos and videos · no watermark</p>
        </header>
        <main className="flex flex-1 flex-col">
          <section className="mt-10 sm:mt-14">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">Instagram · TikTok · X</p>
            <h1 className="font-display mt-3 max-w-[14ch] text-4xl font-medium leading-[1.1] tracking-[-0.03em] sm:text-5xl">
              Save the clip. Leave the watermark.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-muted">
              Paste a public post. Save the video, one photo, or every still in a gallery — original quality. TikTok without the logo.
            </p>
            <form
              className="mt-8"
              onSubmit={(event) => {
                event.preventDefault();
                void fetchPost(inputRef.current?.value || draft, true);
              }}
            >
              <label htmlFor="clip-url" className="sr-only">
                Post link
              </label>
              <div className="rounded-xl bg-surface p-2 shadow-[var(--shadow-border)]">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative min-w-0 flex-1">
                    <input
                      ref={inputRef}
                      id="clip-url"
                      defaultValue=""
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="Paste a post link or share text"
                      enterKeyHint="go"
                      autoComplete="off"
                      onChange={(event) => onInput(event.currentTarget.value)}
                      className="h-12 w-full rounded-lg bg-transparent px-4 pr-10 text-base text-fg outline-none placeholder:text-subtle"
                    />
                    {draft ? (
                      <button
                        type="button"
                        aria-label="Clear link"
                        className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-subtle hover:text-fg"
                        onClick={() => {
                          requestId.current += 1;
                          setDraft("");
                          if (inputRef.current) inputRef.current.value = "";
                          setMedia(null);
                          setStatus("idle");
                          setError(null);
                          setPicked([]);
                          setSelectedId(null);
                          clearReady();
                          inputRef.current?.focus();
                        }}
                      >
                        <X className="size-4" />
                      </button>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-label="Paste from clipboard"
                      onClick={() => void pasteLink()}
                      className="inline-flex h-12 items-center gap-2 rounded-lg bg-surface px-5 text-sm font-medium text-fg shadow-[var(--shadow-border)]"
                    >
                      <ClipboardPaste className="size-4" />
                      Paste
                    </button>
                    <button
                      type="submit"
                      disabled={status === "loading"}
                      className="inline-flex h-12 min-w-28 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-medium text-accent-fg disabled:opacity-40 sm:flex-none"
                    >
                      {status === "loading" ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Reading
                        </>
                      ) : (
                        "Fetch"
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtle">
                {detected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-muted shadow-[var(--shadow-border)]">
                    <PlatformIcon platform={detected} className="size-3.5" />
                    {platformName(detected)}
                  </span>
                ) : (
                  <span>Public posts only</span>
                )}
                <span>·</span>
                <span>Tap Paste, or paste once into the field</span>
              </div>
            </form>
          </section>

          {status === "loading" ? (
            <div className="reveal mt-8 overflow-hidden rounded-xl bg-surface p-3 shadow-[var(--shadow-border)]">
              <div className="aspect-[9/16] max-h-[420px] w-full animate-pulse rounded-lg bg-surface-2 sm:aspect-video" />
              <div className="mt-4 space-y-2 px-1 pb-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-surface-2" />
              </div>
            </div>
          ) : null}

          {status === "error" && error ? (
            <p role="alert" className="reveal mt-6 rounded-xl bg-surface px-4 py-3 text-sm leading-relaxed text-danger shadow-[var(--shadow-border)]">
              {error}
            </p>
          ) : null}

          {status === "ready" && media && selected ? (
            <article className="reveal mt-8 overflow-hidden rounded-xl bg-surface p-3 shadow-[var(--shadow-border)]">
              <div className="overflow-hidden rounded-lg bg-bg">
                {selected.kind === "video" ? (
                  <video
                    key={selected.id}
                    src={proxyUrl(selected.url, downloadName)}
                    poster={media.thumbnail ? proxyUrl(media.thumbnail, "thumb.jpg") : undefined}
                    controls
                    playsInline
                    preload="metadata"
                    className="mx-auto max-h-[min(70vh,540px)] w-full bg-bg object-contain"
                  />
                ) : selected.kind === "audio" ? (
                  <div className="flex flex-col items-center gap-4 px-4 py-10">
                    <audio src={proxyUrl(selected.url, downloadName)} controls className="w-full" />
                  </div>
                ) : (
                  <img
                    key={selected.id}
                    src={proxyUrl(selected.url, downloadName)}
                    alt=""
                    className="mx-auto max-h-[min(70vh,540px)] w-full object-contain"
                  />
                )}
              </div>
              <div className="px-2 pb-2 pt-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <PlatformIcon platform={media.platform} />
                  <span>{platformName(media.platform)}</span>
                  {media.platform === "tiktok" && (selected.noWatermark || photos.length > 0) ? (
                    <span className="rounded-full px-2 py-0.5 uppercase tracking-wide shadow-[var(--shadow-border)]">No watermark</span>
                  ) : null}
                  {photos.length > 1 ? <span className="tabular-nums">{photos.length} photos</span> : null}
                  {formatDuration(media.duration) ? <span className="tabular-nums">{formatDuration(media.duration)}</span> : null}
                </div>
                <h2 className="mt-1 truncate font-display text-xl font-medium tracking-tight">{media.title}</h2>
                <p className="mt-0.5 text-sm text-muted">
                  {media.author}
                  {media.authorHandle ? ` · @${media.authorHandle}` : ""}
                </p>
                {media.notice ? <p className="mt-3 text-sm leading-relaxed text-muted">{media.notice}</p> : null}

                {showKindToggle ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {photos.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setSelectedId(photos[0].id)}
                        className={`h-10 rounded-full px-3.5 text-sm ${selected.kind === "image" ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}
                      >
                        {photos.length === 1 ? "Photo" : `${photos.length} photos`}
                      </button>
                    ) : null}
                    {groups.map((group, index) => (
                      <button
                        key={group[0].id}
                        type="button"
                        onClick={() => setSelectedId(group[0].id)}
                        className={`h-10 rounded-full px-3.5 text-sm ${selectedGroup === group ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}
                      >
                        {groups.length > 1 ? `Video ${index + 1}` : "Video"}
                      </button>
                    ))}
                  </div>
                ) : null}

                {photoMode && photos.length > 1 ? (
                  <PhotoGrid
                    photos={photos}
                    focusedId={selected.id}
                    picked={picked}
                    onFocus={(id) => {
                      setSelectedId(id);
                      setPicked((current) => (current.includes(id) ? current : [...current, id]));
                    }}
                    onToggle={(id) => setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))}
                    onAll={() => setPicked(photos.map((photo) => photo.id))}
                    onNone={() => setPicked([])}
                  />
                ) : null}

                {selectedGroup && selectedGroup.length > 1 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedGroup.map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setSelectedId(variant.id)}
                        className={`h-10 rounded-full px-3.5 text-sm ${variant.id === selected.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}
                      >
                        {variant.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                {audiosOf(media).length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {audiosOf(media).map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setSelectedId(variant.id)}
                        className={`h-10 rounded-full px-3.5 text-sm shadow-[var(--shadow-border)] ${variant.id === selected.id ? "bg-accent text-accent-fg" : "text-muted"}`}
                      >
                        Audio
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                  <a
                    href={ready?.url}
                    download={ready?.file.name || downloadName}
                    aria-disabled={preparing || saveCount === 0 ? true : undefined}
                    onClick={(event) => onSaveClick(event)}
                    className={`inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-medium text-accent-fg ${preparing || saveCount === 0 ? "pointer-events-none opacity-60" : ""}`}
                  >
                    {preparing && !ready ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    {preparing && !ready ? "Preparing" : saveLabel}
                  </a>
                  <a
                    href={proxyUrl(selected.url, downloadName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-surface px-5 text-sm font-medium text-fg shadow-[var(--shadow-border)] sm:flex-none"
                  >
                    <ExternalLink className="size-4" />
                    Open file
                  </a>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-subtle">
                  {preparing && !ready
                    ? "Getting the file ready so the first save goes through."
                    : saveFault && !ready
                      ? saveFault
                      : media.platform === "instagram"
                        ? "On iPhone, Save opens the share sheet — tap Save Video or Save Image. If Photos doesn’t offer it, the file still downloads."
                        : "On iPhone, Save puts it in Files or Photos."}
                </p>
              </div>
            </article>
          ) : null}

          {status === "idle" ? <HowTo /> : null}
          <Samples onPick={(url) => void fetchPost(url, true)} />
          {history.length > 0 ? (
            <HistoryRow
              items={history}
              onPick={(url) => void fetchPost(url, true)}
              onRemove={(id) => {
                const next = readHistory().filter((item) => item.id !== id);
                writeHistory(next);
                setHistory(next);
              }}
              onClear={() => {
                writeHistory([]);
                setHistory([]);
              }}
            />
          ) : null}
        </main>
        <footer className="mt-12 text-xs leading-relaxed text-subtle">For personal copies of public posts. Respect creators.</footer>
      </div>
    </div>
  );
}

function PhotoGrid({
  photos,
  focusedId,
  picked,
  onFocus,
  onToggle,
  onAll,
  onNone,
}: {
  photos: Variant[];
  focusedId: string;
  picked: string[];
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const allOn = photos.every((photo) => picked.includes(photo.id));
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <span className="tabular-nums text-fg">{picked.length}</span> of{" "}
          <span className="tabular-nums">{photos.length}</span> photos
        </p>
        <div className="flex gap-3">
          <button type="button" className="h-10 px-1 text-sm text-muted disabled:text-subtle" disabled={allOn} onClick={onAll}>
            Select all
          </button>
          <button type="button" className="h-10 px-1 text-sm text-muted disabled:text-subtle" disabled={picked.length === 0} onClick={onNone}>
            None
          </button>
        </div>
      </div>
      <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo, index) => {
          const on = picked.includes(photo.id);
          const number = photo.index ?? index + 1;
          return (
            <li key={photo.id} className={`relative overflow-hidden rounded-lg bg-surface-2 ${photo.id === focusedId ? "shadow-[var(--shadow-border-hover)]" : "shadow-[var(--shadow-border)]"}`}>
              <button type="button" className="block aspect-[3/4] w-full" onClick={() => onFocus(photo.id)} aria-label={`View photo ${number}`}>
                <img src={proxyUrl(photo.url, `photo-${number}.jpg`)} alt="" className="size-full object-cover" />
              </button>
              <button
                type="button"
                aria-pressed={on}
                aria-label={on ? `Deselect photo ${number}` : `Select photo ${number}`}
                onClick={() => onToggle(photo.id)}
                className={`absolute right-1 top-1 flex size-10 items-center justify-center rounded-full ${on ? "bg-accent text-accent-fg" : "bg-bg/80 text-fg"}`}
              >
                {on ? <Check className="size-4" /> : null}
              </button>
              <span className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-bg/80 px-2 py-0.5 text-xs tabular-nums">{number}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HowTo() {
  const steps: { platform: Platform; title: string; body: string }[] = [
    {
      platform: "tiktok",
      title: "TikTok",
      body: "Share → Copy link. Paste that, even if TikTok adds extra words. Videos come back without the watermark. Photo posts save as stills you can put in Photos — not the slideshow clip.",
    },
    {
      platform: "instagram",
      title: "Instagram",
      body: "On a Reel or post, tap ··· → Copy link. Carousels save every still (pick which ones). Save downloads the file even if Photos doesn’t offer Save Video. Stories and private accounts won’t work.",
    },
    {
      platform: "x",
      title: "X",
      body: "Open the post → Share → Copy link. Photo+video posts let you switch between stills and the clip, then pick a quality.",
    },
  ];
  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium text-muted">How to copy a link</h2>
      <ul className="mt-3 grid gap-3">
        {steps.map((step) => (
          <li key={step.platform} className="flex gap-3 rounded-xl bg-surface px-4 py-4 shadow-[var(--shadow-border)]">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2">
              <PlatformIcon platform={step.platform} />
            </span>
            <div>
              <p className="text-sm font-medium">{step.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Samples({ onPick }: { onPick: (url: string) => void }) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-subtle">Try a sample</span>
      {SAMPLES.map((sample) => (
        <button
          key={sample.url}
          type="button"
          onClick={() => onPick(sample.url)}
          className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-muted shadow-[var(--shadow-border)] hover:text-fg"
        >
          <PlatformIcon platform={sample.platform} className="size-3.5" />
          {sample.label}
        </button>
      ))}
    </div>
  );
}

function HistoryRow({
  items,
  onPick,
  onRemove,
  onClear,
}: {
  items: HistoryItem[];
  onPick: (url: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="mt-12">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">Recent</h2>
        <button type="button" onClick={onClear} className="h-10 px-1 text-xs text-subtle hover:text-fg">
          Clear
        </button>
      </div>
      <ul className="mt-3 flex gap-3 overflow-x-auto pb-1">
        {items.map((item) => (
          <li key={item.id} className="relative w-28 shrink-0">
            <button type="button" onClick={() => onPick(item.sourceUrl)} className="block w-full overflow-hidden rounded-lg bg-surface text-left shadow-[var(--shadow-border)]">
              <div className="flex aspect-[3/4] items-center justify-center bg-surface-2">
                {item.thumbnail ? (
                  <img src={proxyUrl(item.thumbnail, "thumb.jpg")} alt="" className="size-full object-cover" />
                ) : (
                  <PlatformIcon platform={item.platform} className="size-5 text-subtle" />
                )}
              </div>
              <p className="truncate px-2 pt-2 text-xs">{item.title}</p>
              <p className="truncate px-2 pb-2 text-[10px] text-subtle">{item.author}</p>
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.title} from recent`}
              onClick={() => onRemove(item.id)}
              className="absolute right-1 top-1 flex size-9 items-center justify-center rounded-full bg-bg/80"
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
