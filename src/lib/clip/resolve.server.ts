import { ByteLru } from "./cache";
import { egressFetch } from "./egress.server";
import { ensureHttp, extractPostUrl, isInstagramLink, isRedditHost, platformOf } from "./links";
import type { ClipMedia, Variant } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class ClipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipError";
  }
}

const RESOLVE_TTL_MS = 4 * 60 * 1000;
/** Bounded so a flood of distinct posts can't grow this map without limit. */
const resolveCache = new ByteLru<ClipMedia>({
  maxEntries: 200,
  maxBytes: Number.MAX_SAFE_INTEGER,
  ttlMs: RESOLVE_TTL_MS,
});

async function readText(url: string, headers: HeadersInit, timeoutMs = 20000): Promise<Response> {
  return egressFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function qualityLabel(width?: number, height?: number): string {
  const shortSide = Math.min(width || 0, height || 0);
  const buckets = [2160, 1440, 1080, 720, 540, 480, 360];
  const bucket = buckets.find((size) => shortSide >= size - 80);
  if (bucket) return `${bucket}p`;
  if (shortSide) return `${shortSide}p`;
  return "Video";
}

async function resolveTikTok(raw: string): Promise<ClipMedia> {
  const sourceUrl = ensureHttp(raw);
  let data: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await readText(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(sourceUrl)}`, {
      "User-Agent": UA,
      Accept: "application/json",
    });
    const json = asRecord(await response.json().catch(() => null));
    const next = asRecord(json?.data);
    if (response.ok && next && json?.code === 0) {
      data = next;
      break;
    }
    const message = str(json?.msg) || "";
    if (!/limit|too many|rate/i.test(message)) break;
  }
  if (!data) {
    throw new ClipError("TikTok didn’t return that post. Check that it’s public, then paste the share link again.");
  }
  const author = asRecord(data.author);
  const handle = str(author?.unique_id);
  const name = str(author?.nickname) || handle || "TikTok";
  const title = str(data.title) || "TikTok";
  const images = Array.isArray(data.images) ? data.images.filter((item): item is string => typeof item === "string") : [];
  // Live Photo motion videos ride alongside the stills in `live_images`
  // (same order, one per slide). Without these, Live Photos save as plain photos.
  const liveImages = Array.isArray(data.live_images)
    ? data.live_images.filter((item): item is string => typeof item === "string")
    : [];
  const variants: Variant[] = [];
  if (images.length) {
    images.forEach((url, index) => {
      variants.push({
        id: `photo-${index + 1}`,
        kind: "image",
        label: images.length > 1 ? `Photo ${index + 1}` : "Photo",
        url,
        ext: "jpg",
        index: index + 1,
        noWatermark: true,
      });
      const motion = liveImages[index];
      if (motion) {
        variants.push({
          id: `live-video-${index + 1}`,
          kind: "video",
          label: images.length > 1 ? `Live video ${index + 1}` : "Live video",
          url: motion,
          ext: "mp4",
          index: index + 1,
          noWatermark: true,
        });
      }
    });
  } else {
    const hd = str(data.hdplay);
    const play = str(data.play);
    if (hd) {
      variants.push({
        id: "video-hd",
        kind: "video",
        label: "HD · no watermark",
        url: hd,
        ext: "mp4",
        noWatermark: true,
        group: str(data.id) || "video",
      });
    }
    if (play && play !== hd) {
      variants.push({
        id: "video-sd",
        kind: "video",
        label: "Video · no watermark",
        url: play,
        ext: "mp4",
        noWatermark: true,
        group: str(data.id) || "video",
      });
    }
    const music = str(data.music);
    if (music) {
      variants.push({
        id: "audio",
        kind: "audio",
        label: "Audio",
        url: music,
        ext: "mp3",
      });
    }
  }
  if (!variants.length) {
    throw new ClipError("TikTok didn’t include a photo or video on that post.");
  }
  return {
    platform: "tiktok",
    sourceUrl,
    title,
    author: name,
    authorHandle: handle,
    thumbnail: str(data.origin_cover) || str(data.cover),
    duration: images.length ? undefined : num(data.duration),
    variants,
  };
}

function xStatusId(raw: string): string | null {
  try {
    return new URL(ensureHttp(raw)).pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function resolveX(raw: string): Promise<ClipMedia> {
  let source = ensureHttp(raw);
  if (new URL(source).hostname.replace(/^www\./, "") === "t.co") {
    const response = await fetch(source, {
      redirect: "manual",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(12000),
    });
    const location = response.headers.get("location");
    if (!location) throw new ClipError("That short X link didn’t open. Paste the post link instead.");
    source = new URL(location, source).toString();
  }
  const id = xStatusId(source);
  if (!id) throw new ClipError("Paste the X post link — the one with /status/ in it.");
  const response = await readText(`https://api.fxtwitter.com/status/${id}`, {
    "User-Agent": UA,
    Accept: "application/json",
  });
  const json = asRecord(await response.json().catch(() => null));
  const tweet = asRecord(json?.tweet);
  if (!response.ok || !tweet) {
    throw new ClipError("X didn’t return that post. It may be private, deleted, or still processing.");
  }
  const author = asRecord(tweet.author);
  const media = asRecord(tweet.media);
  const all = Array.isArray(media?.all) ? media.all : [];
  const variants: Variant[] = [];
  let photoIndex = 0;
  for (const entry of all) {
    const item = asRecord(entry);
    if (!item) continue;
    const url = str(item.url);
    if (!url || url.includes(".m3u8")) continue;
    const type = str(item.type);
    if (type === "photo" || type === "image") {
      photoIndex += 1;
      variants.push({
        id: `photo-${str(item.id) || photoIndex}`,
        kind: "image",
        label: `Photo ${photoIndex}`,
        url,
        ext: "jpg",
        width: num(item.width),
        height: num(item.height),
        index: photoIndex,
      });
      continue;
    }
    if (type !== "video" && type !== "gif") continue;
    const group = str(item.id) || "video";
    const formats = Array.isArray(item.formats) ? item.formats : [];
    const mp4s = formats
      .map((format) => asRecord(format))
      .filter((format): format is Record<string, unknown> => !!format && str(format.container) === "mp4" && !!str(format.url));
    if (mp4s.length) {
      const ranked = [...mp4s].sort((a, b) => (num(b.bitrate) || 0) - (num(a.bitrate) || 0));
      for (const format of ranked) {
        const formatUrl = str(format.url)!;
        const size = formatUrl.match(/(\d{3,4})x(\d{3,4})/);
        const width = size ? Number(size[1]) : num(item.width);
        const height = size ? Number(size[2]) : num(item.height);
        variants.push({
          id: `video-${group}-${width || 0}-${num(format.bitrate) || 0}`,
          kind: "video",
          label: qualityLabel(width, height),
          url: formatUrl,
          ext: "mp4",
          width,
          height,
          bitrate: num(format.bitrate),
          group,
        });
      }
    } else {
      variants.push({
        id: `video-${group}`,
        kind: "video",
        label: qualityLabel(num(item.width), num(item.height)),
        url,
        ext: "mp4",
        width: num(item.width),
        height: num(item.height),
        group,
      });
    }
  }
  if (!variants.length) throw new ClipError("That X post doesn’t have a photo or video to save.");
  const text = str(tweet.text) || "X post";
  let thumbnail: string | undefined;
  for (const entry of all) {
    const item = asRecord(entry);
    const thumb = item ? str(item.thumbnail_url) : undefined;
    if (thumb) {
      thumbnail = thumb;
      break;
    }
  }
  const firstVideo = all.map((entry) => asRecord(entry)).find((item) => item && str(item.type) === "video");
  return {
    platform: "x",
    sourceUrl: str(tweet.url) || `https://x.com/i/status/${id}`,
    title: text.replace(/\s+/g, " ").trim(),
    author: str(author?.name) || str(author?.screen_name) || "X",
    authorHandle: str(author?.screen_name),
    thumbnail: variants.find((variant) => variant.kind === "image")?.url || thumbnail,
    duration: firstVideo ? num(firstVideo.duration) : undefined,
    variants,
  };
}

export async function resolveClipUrl(input: string, options?: { fresh?: boolean }): Promise<ClipMedia> {
  if (isInstagramLink(input)) {
    throw new ClipError("Instagram links aren’t supported. Paste a TikTok or X link.");
  }
  const extracted = extractPostUrl(input);
  if (!extracted) {
    let hostname = "";
    try {
      hostname = new URL(ensureHttp(input.trim())).hostname;
    } catch {
      hostname = "";
    }
    if (hostname && isRedditHost(hostname)) {
      throw new ClipError("Clipkeep doesn’t save Reddit posts. Paste a TikTok or X link.");
    }
    throw new ClipError("Paste a TikTok or X link.");
  }
  const platform = platformOf(extracted);
  const statusId = platform === "x" ? extracted.match(/\/status\/(\d+)/)?.[1] : null;
  const cacheKey =
    platform === "x" && statusId ? `x:${statusId}` : platform === "tiktok" ? `tt:${extracted.split("?")[0]}` : "";
  if (!options?.fresh && cacheKey) {
    const hit = resolveCache.get(cacheKey);
    if (hit) return hit;
  }
  let media: ClipMedia;
  if (platform === "tiktok") media = await resolveTikTok(extracted);
  else if (platform === "x") media = await resolveX(extracted);
  else throw new ClipError("Paste a TikTok or X link.");
  if (cacheKey && !media.notice) resolveCache.set(cacheKey, media);
  return media;
}
