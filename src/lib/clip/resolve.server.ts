import { egressFetch, rotateEgress, runWithEgress } from "./egress.server";
import {
  ensureHttp,
  extractPostUrl,
  instagramShortcode,
  isInstagramStory,
  isRedditHost,
  platformOf,
} from "./links";
import type { ClipMedia, Variant } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const IG_APP = "936619743392459";
const IG_DOC = "27130156389949648";

class ClipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipError";
  }
}

const RESOLVE_TTL_MS = 4 * 60 * 1000;
const resolveCache = new Map<string, { at: number; media: ClipMedia }>();

async function readText(url: string, headers: HeadersInit, timeoutMs = 20000): Promise<Response> {
  return egressFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
}

function shortcodeToId(code: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let n = 0n;
  for (const char of code) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new ClipError("That Instagram link looks cut off. Copy it again from the post.");
    n = n * 64n + BigInt(index);
  }
  return n.toString();
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

function cleanMediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("bytestart");
    parsed.searchParams.delete("byteend");
    return parsed.toString();
  } catch {
    return url;
  }
}

function bestImage(item: Record<string, unknown>): { url: string; width?: number; height?: number } | null {
  const versions = asRecord(item.image_versions2);
  const candidates = Array.isArray(versions?.candidates) ? versions.candidates : [];
  const ranked = candidates
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry && !!str(entry.url))
    .sort((a, b) => (num(b.width) || 0) * (num(b.height) || 0) - (num(a.width) || 0) * (num(a.height) || 0));
  const top = ranked[0];
  if (top) {
    const url = cleanMediaUrl(str(top.url));
    return url ? { url, width: num(top.width), height: num(top.height) } : null;
  }
  const display = cleanMediaUrl(str(item.display_uri) || str(item.display_url));
  return display ? { url: display } : null;
}

function videoList(item: Record<string, unknown>): Array<{ url: string; width?: number; height?: number }> {
  const list = Array.isArray(item.video_versions) ? item.video_versions : [];
  const seen = new Set<string>();
  const videos = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const url = record ? cleanMediaUrl(str(record.url)) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    videos.push({ url, width: num(record?.width), height: num(record?.height) });
  }
  videos.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return videos;
}

function pushVideo(
  variants: Variant[],
  video: { url: string; width?: number; height?: number },
  group: string,
  noWatermark = false,
) {
  const label = qualityLabel(video.width, video.height);
  variants.push({
    id: `video-${group}-${video.width || 0}x${video.height || 0}-${variants.length}`,
    kind: "video",
    label,
    url: video.url,
    ext: "mp4",
    width: video.width,
    height: video.height,
    group,
    noWatermark,
  });
}

async function resolveInstagramShare(raw: string): Promise<string> {
  const url = new URL(ensureHttp(raw));
  if (!/\/share\/(?:p|reel|reels)\//i.test(url.pathname)) return url.toString();
  const response = await egressFetch(url.toString(), {
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    signal: AbortSignal.timeout(15000),
  });
  const location = response.headers.get("location");
  if (!location) {
    throw new ClipError("That Instagram share link didn’t open. On the post, tap ··· → Copy link again.");
  }
  return new URL(location, url).toString();
}

function extractLsd(html: string): string {
  return (
    html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] ||
    html.match(/id="__eqmc"[^>]*>\{[^<]*"l":"([^"]+)"/)?.[1] ||
    ""
  );
}

type IgSession = { pageUrl: string; cookies: string; csrf: string; lsd: string };

const IG_SHORTCODE_DOC = "27128499623469141";

async function instagramSession(code: string): Promise<IgSession | "rate" | null> {
  const pageUrl = `https://www.instagram.com/p/${code}/`;
  const page = await readText(pageUrl, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  });
  if (page.status === 429) {
    await page.body?.cancel().catch(() => undefined);
    return "rate";
  }
  const html = await page.text();
  const cookies = (page.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]).join("; ");
  const csrf = cookies.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || "";
  if (!csrf) return null;
  return { pageUrl, cookies, csrf, lsd: extractLsd(html) };
}

function instagramItem(json: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = asRecord(json?.data);
  if (!data) return null;
  const web = asRecord(data.xdt_api__v1__media__shortcode__web_info);
  const items = Array.isArray(web?.items) ? web.items : [];
  const first = asRecord(items[0]);
  if (first && (first.video_versions || first.image_versions2 || first.carousel_media || first.display_uri)) return first;
  const polaris = asRecord(data.xig_polaris_media);
  const gated = polaris ? asRecord(polaris.if_not_gated_logged_out) || asRecord(polaris.if_not_gated) : null;
  if (gated) return gated;
  if (polaris && (polaris.video_versions || polaris.image_versions2 || polaris.carousel_media)) return polaris;
  return null;
}

function instagramFailure(json: Record<string, unknown> | null): "private" | "retry" {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const text = JSON.stringify(errors);
  if (/not found|unavailable|private|restricted|login/i.test(text)) return "private";
  return "retry";
}

async function postInstagram(
  endpoint: string,
  session: IgSession,
  fields: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-IG-App-ID": IG_APP,
    "X-ASBD-ID": "359341",
    "X-IG-WWW-Claim": "0",
    Origin: "https://www.instagram.com",
    "X-CSRFToken": session.csrf,
    "X-Requested-With": "XMLHttpRequest",
    Referer: session.pageUrl,
    Cookie: session.cookies,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (session.lsd) headers["X-FB-LSD"] = session.lsd;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const response = await egressFetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 429, json: null };
  }
  const text = await response.text();
  if (!response.ok || text.trimStart().startsWith("<")) return { status: response.status, json: null };
  try {
    return { status: response.status, json: asRecord(JSON.parse(text)) };
  } catch {
    return { status: response.status, json: null };
  }
}

async function instagramByShortcode(
  session: IgSession,
  code: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return postInstagram("https://www.instagram.com/graphql/query", session, {
    variables: JSON.stringify({
      shortcode: code,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    }),
    doc_id: IG_SHORTCODE_DOC,
    server_timestamps: "true",
  });
}

async function instagramByMediaId(
  session: IgSession,
  code: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return postInstagram(
    "https://www.instagram.com/api/graphql",
    session,
    {
      lsd: session.lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "PolarisLoggedOutDesktopWWWPostRootContentQuery",
      server_timestamps: "true",
      variables: JSON.stringify({ media_id: shortcodeToId(code) }),
      doc_id: IG_DOC,
    },
    { "X-FB-Friendly-Name": "PolarisLoggedOutDesktopWWWPostRootContentQuery" },
  );
}

async function instagramOembed(sourceUrl: string): Promise<{
  title?: string;
  author?: string;
  thumbnail?: string;
} | null> {
  const response = await readText(
    `https://www.instagram.com/api/v1/oembed/?hidecaption=true&url=${encodeURIComponent(sourceUrl)}`,
    {
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.instagram.com/",
      "X-IG-App-ID": IG_APP,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  );
  if (!response.ok) return null;
  const json = asRecord(await response.json().catch(() => null));
  if (!json) return null;
  return {
    title: str(json.title),
    author: str(json.author_name),
    thumbnail: str(json.thumbnail_url),
  };
}

function clipFromInstagramItem(
  info: Record<string, unknown>,
  sourceUrl: string,
  code: string,
): ClipMedia {
  const user = asRecord(info.user);
  const authorHandle = str(user?.username);
  const caption = str(asRecord(info.caption)?.text) || "Instagram post";
  const variants: Variant[] = [];
  const carousel = Array.isArray(info.carousel_media) ? info.carousel_media : null;
  const items = carousel?.length ? carousel.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => !!item) : [info];

  let photoIndex = 0;
  items.forEach((item, itemIndex) => {
    const group = str(item.pk) || str(item.id) || `${code}-${itemIndex}`;
    const videos = videoList(item);
    if (videos.length) {
      for (const video of videos) pushVideo(variants, video, group);
      return;
    }
    const image = bestImage(item);
    if (!image) return;
    photoIndex += 1;
    variants.push({
      id: `photo-${group}`,
      kind: "image",
      label: items.length > 1 ? `Photo ${photoIndex}` : "Photo",
      url: image.url,
      ext: "jpg",
      width: image.width,
      height: image.height,
      index: photoIndex,
    });
  });

  if (!variants.length) {
    throw new ClipError(
      "Instagram didn’t return a file for this post. Make sure it’s public, then copy the link again.",
    );
  }

  const cover = bestImage(info);
  const duration =
    num(info.video_duration) ||
    (num(asRecord(asRecord(info.clips_metadata)?.original_sound_info)?.duration_in_ms)
      ? num(asRecord(asRecord(info.clips_metadata)?.original_sound_info)?.duration_in_ms)! / 1000
      : undefined);

  return {
    platform: "instagram",
    sourceUrl,
    title: caption.replace(/\s+/g, " ").trim(),
    author: authorHandle || "Instagram",
    authorHandle,
    thumbnail: cover?.url,
    duration,
    variants,
  };
}

async function resolveInstagram(raw: string): Promise<ClipMedia> {
  if (isInstagramStory(raw)) {
    throw new ClipError("Stories and private accounts won’t save. Use a public Reel or post.");
  }
  const opened = await resolveInstagramShare(raw);
  const code = instagramShortcode(opened);
  if (!code || code.length < 8) {
    throw new ClipError(
      "That Instagram link looks cut off. Copy it again from the Reel or post — Share → Copy link — so the full code is included.",
    );
  }
  const sourceUrl = `https://www.instagram.com/${/\/reel/.test(opened) ? "reel" : "p"}/${code}/`;
  let sawPrivate = false;
  let sawRate = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) {
      rotateEgress();
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
    const outcome = await runWithEgress(async () => {
      const session = await instagramSession(code);
      if (session === "rate") return "rate" as const;
      if (!session) return "retry" as const;
      const primary = await instagramByShortcode(session, code);
      if (primary.status === 429) return "rate" as const;
      const item = instagramItem(primary.json);
      if (item) return clipFromInstagramItem(item, sourceUrl, code);
      if (primary.json && instagramFailure(primary.json) === "private") return "private" as const;
      if (attempt === 0) {
        const legacy = await instagramByMediaId(session, code);
        if (legacy.status === 429) return "rate" as const;
        const legacyItem = instagramItem(legacy.json);
        if (legacyItem) return clipFromInstagramItem(legacyItem, sourceUrl, code);
        if (legacy.json && instagramFailure(legacy.json) === "private") return "private" as const;
      }
      return "retry" as const;
    });
    if (typeof outcome !== "string") return outcome;
    if (outcome === "private") {
      sawPrivate = true;
      break;
    }
    if (outcome === "rate") sawRate = true;
  }

  if (sawPrivate) {
    throw new ClipError("That post is private or unavailable. Clipkeep only saves public posts.");
  }

  const embed = await instagramOembed(sourceUrl);
  if (embed?.thumbnail) {
    return {
      platform: "instagram",
      sourceUrl,
      title: embed.title?.replace(/\s+/g, " ").trim() || "Instagram post",
      author: embed.author || "Instagram",
      authorHandle: embed.author,
      thumbnail: embed.thumbnail,
      notice:
        "Instagram only sent the cover photo this time, not the full clip. Tap Fetch again in a moment — public Reels usually come through on the next try.",
      variants: [
        {
          id: "cover",
          kind: "image",
          label: "Cover photo",
          url: embed.thumbnail,
          ext: "jpg",
          index: 1,
        },
      ],
    };
  }

  throw new ClipError(
    sawRate
      ? "Instagram is rate-limiting us right now. Wait a minute and try again."
      : "Instagram didn’t return this post. Make sure it’s public, then copy the link from Share → Copy link. If it still fails, Instagram is blocking the request — try again in a minute.",
  );
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
  const extracted = extractPostUrl(input);
  if (!extracted) {
    let hostname = "";
    try {
      hostname = new URL(ensureHttp(input.trim())).hostname;
    } catch {
      hostname = "";
    }
    if (hostname && isRedditHost(hostname)) {
      throw new ClipError("Clipkeep doesn’t save Reddit posts. Paste a TikTok, Instagram, or X link.");
    }
    throw new ClipError("Paste a TikTok, Instagram, or X link.");
  }
  const platform = platformOf(extracted);
  const code = platform === "instagram" ? instagramShortcode(extracted) : null;
  const statusId = platform === "x" ? extracted.match(/\/status\/(\d+)/)?.[1] : null;
  const cacheKey =
    platform === "instagram" && code
      ? `ig:${code}`
      : platform === "x" && statusId
        ? `x:${statusId}`
        : platform === "tiktok"
          ? `tt:${extracted.split("?")[0]}`
          : "";
  if (!options?.fresh && cacheKey) {
    const hit = resolveCache.get(cacheKey);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.media;
  }
  let media: ClipMedia;
  if (platform === "instagram") media = await resolveInstagram(extracted);
  else if (platform === "tiktok") media = await resolveTikTok(extracted);
  else if (platform === "x") media = await resolveX(extracted);
  else throw new ClipError("Paste a TikTok, Instagram, or X link.");
  if (cacheKey && !media.notice) resolveCache.set(cacheKey, { at: Date.now(), media });
  return media;
}
