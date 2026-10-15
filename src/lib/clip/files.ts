import { ByteLru } from "./cache";
import { egressFetch } from "./egress.server";
import { stampMp4Times } from "./mp4";

const ALLOWED = [
  /(^|\.)cdninstagram\.com$/i,
  /(^|\.)fbcdn\.net$/i,
  /(^|\.)tiktokcdn\.com$/i,
  /(^|\.)tiktokcdn-us\.com$/i,
  /(^|\.)tiktokcdn-eu\.com$/i,
  /(^|\.)tiktokv\.com$/i,
  /(^|\.)twimg\.com$/i,
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BYTES = 48 * 1024 * 1024;
const CACHE_MS = 120_000;

/**
 * Full-file buffers, bounded by entry count and total retained bytes. Without
 * these caps, distinct query params on the same CDN file pin many 48 MB copies
 * in memory — see cache.ts.
 */
const fullLoads = new ByteLru<Promise<{ type: string; bytes: Uint8Array }>>({
  maxEntries: 12,
  maxBytes: 72 * 1024 * 1024,
  ttlMs: CACHE_MS,
});

const IG_CONCURRENCY = 2;
const IG_GAP_MS = 400;
let igActive = 0;
let igNextAt = 0;
let igTimer: ReturnType<typeof setTimeout> | null = null;
const igWaiters: Array<() => void> = [];

class UpstreamStatus extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UpstreamStatus";
    this.status = status;
  }
}

function pumpIg() {
  if (igTimer || igActive >= IG_CONCURRENCY || igWaiters.length === 0) return;
  const delay = Math.max(0, igNextAt - Date.now());
  if (delay > 0) {
    igTimer = setTimeout(() => {
      igTimer = null;
      pumpIg();
    }, delay);
    return;
  }
  igNextAt = Date.now() + IG_GAP_MS;
  igActive += 1;
  const resume = igWaiters.shift();
  resume?.();
  pumpIg();
}

function acquireIg(): Promise<void> {
  return new Promise((resolve) => {
    igWaiters.push(resolve);
    pumpIg();
  });
}

function releaseIg() {
  igActive = Math.max(0, igActive - 1);
  pumpIg();
}

function instagramHost(hostname: string): boolean {
  return /instagram|fbcdn/i.test(hostname);
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "").replace(/[^\w.\- ]+/g, "").trim().slice(0, 80);
  return cleaned || "clipkeep";
}

function allowedHost(hostname: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(hostname));
}

function refererFor(hostname: string): string {
  if (/instagram|fbcdn/i.test(hostname)) return "https://www.instagram.com/";
  if (/tiktok/i.test(hostname)) return "https://www.tiktok.com/";
  if (/twimg/i.test(hostname)) return "https://x.com/";
  return "https://clipkeep.grok.me/";
}

function contentType(response: Response): string {
  return (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function htmlType(type: string): boolean {
  return type.startsWith("text/") || type.includes("html") || type.includes("json");
}

function htmlBytes(bytes: Uint8Array): boolean {
  const sample = new TextDecoder().decode(bytes.subarray(0, 80)).trimStart().toLowerCase();
  return sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.startsWith("<head");
}

function fail(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function fetchAllowed(initial: URL, range: string | null, accept = "*/*"): Promise<Response> {
  let current = initial;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!allowedHost(current.hostname)) {
      throw new Error("That file host isn’t allowed.");
    }
    const headers = new Headers({
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: refererFor(current.hostname),
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    });
    if (range) headers.set("Range", range);
    const instagram = instagramHost(current.hostname);
    if (!instagram) headers.set("User-Agent", UA);
    const response = await (instagram ? egressFetch : fetch)(current.toString(), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("The file host redirected nowhere.");
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("The file host redirected too many times.");
}

async function loadFull(target: URL, accept: string): Promise<{ type: string; bytes: Uint8Array }> {
  let lastStatus = 0;
  let lastMessage = "Download failed";
  const ig = instagramHost(target.hostname);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt && (lastStatus === 429 || lastStatus === 0)) {
      await new Promise((resolve) => setTimeout(resolve, lastStatus === 429 ? 800 * attempt : 400 * attempt));
    }
    if (ig) await acquireIg();
    let released = false;
    const release = () => {
      if (released || !ig) return;
      released = true;
      releaseIg();
    };
    try {
      let upstream: Response;
      try {
        upstream = await fetchAllowed(target, null, accept);
      } catch (error) {
        const message = error instanceof Error ? error.message : lastMessage;
        if (/isn’t allowed|redirected/i.test(message)) throw error;
        lastStatus = 0;
        lastMessage = message || lastMessage;
        if (attempt === 2) throw new Error(lastMessage);
        continue;
      }

      const status = upstream.status;
      let type = contentType(upstream);
      if (status === 403 || status === 410) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new UpstreamStatus(status, "The file link expired.");
      }
      if (htmlType(type)) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new UpstreamStatus(403, "The file link expired.");
      }
      if (status === 404) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new UpstreamStatus(404, "The file link expired. Fetch the post again, then save.");
      }
      if (status === 429) {
        await upstream.body?.cancel().catch(() => undefined);
        lastStatus = 429;
        if (attempt < 2) continue;
        throw new UpstreamStatus(429, "Rate limited");
      }
      if (!upstream.ok && status !== 206) {
        await upstream.body?.cancel().catch(() => undefined);
        lastStatus = status;
        if (attempt < 2 && status >= 500) continue;
        throw new UpstreamStatus(status || 502, "Download failed");
      }
      if (!type) {
        await upstream.body?.cancel().catch(() => undefined);
        lastStatus = 0;
        lastMessage = "Download failed";
        if (attempt === 2) throw new Error(lastMessage);
        continue;
      }

      if (type === "image/webp" && accept.includes("image/jpeg")) {
        try {
          const jpeg = await fetchAllowed(target, null, "image/jpeg");
          const jpegType = contentType(jpeg);
          if ((jpeg.ok || jpeg.status === 206) && jpegType.startsWith("image/") && jpegType !== "image/webp" && !htmlType(jpegType)) {
            await upstream.body?.cancel().catch(() => undefined);
            upstream = jpeg;
            type = jpegType;
          } else {
            await jpeg.body?.cancel().catch(() => undefined);
          }
        } catch {
          /* keep the first response */
        }
      }

      const length = Number(upstream.headers.get("content-length") || "0");
      if (length > MAX_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error("large");
      }
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw new Error("large");
      if (htmlBytes(bytes)) throw new UpstreamStatus(403, "The file link expired.");
      if (!bytes.byteLength) {
        lastStatus = 0;
        lastMessage = "Download failed";
        if (attempt === 2) throw new Error(lastMessage);
        continue;
      }
      return { type: type || "application/octet-stream", bytes };
    } finally {
      release();
    }
  }
  if (lastStatus === 429) throw new UpstreamStatus(429, "Rate limited");
  throw new Error(lastMessage);
}

function loadFullOnce(target: URL, accept: string): Promise<{ type: string; bytes: Uint8Array }> {
  const key = `${accept}\n${target.toString()}`;
  const existing = fullLoads.get(key);
  if (existing) return existing;
  const pending = loadFull(target, accept);
  // Store the pending promise (weight 0) so concurrent callers share one fetch,
  // then account its bytes and start the TTL once it resolves.
  fullLoads.set(key, pending, 0);
  pending
    .then((stored) => {
      if (fullLoads.peek(key) === pending) fullLoads.weigh(key, stored.bytes.byteLength);
    })
    .catch(() => {
      if (fullLoads.peek(key) === pending) fullLoads.delete(key);
    });
  return pending;
}

function fileResponse(
  bytes: Uint8Array,
  type: string,
  downloadName: string,
  download: boolean,
  rangeHeader: string | null,
): Response {
  let payload = bytes;
  if (download && (type.startsWith("video/") || downloadName.toLowerCase().endsWith(".mp4"))) {
    payload = stampMp4Times(bytes);
  }
  let start = 0;
  let end = payload.byteLength - 1;
  let status = 200;
  if (!download && rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
    if (match) {
      start = Number(match[1]);
      if (start >= payload.byteLength) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${payload.byteLength}` },
        });
      }
      end = match[2] ? Math.min(Number(match[2]), payload.byteLength - 1) : payload.byteLength - 1;
      status = start === 0 && end === payload.byteLength - 1 ? 200 : 206;
    }
  }
  const body = new ArrayBuffer(end - start + 1);
  new Uint8Array(body).set(payload.subarray(start, end + 1));
  const headers = new Headers();
  headers.set("Content-Type", type || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=120");
  headers.set("Content-Length", String(body.byteLength));
  headers.set("X-Content-Type-Options", "nosniff");
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${payload.byteLength}`);
  const disposition = download ? "attachment" : "inline";
  headers.set(
    "Content-Disposition",
    `${disposition}; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  );
  return new Response(body, { status, headers });
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const RATE_MAX_KEYS = 10_000;
const MAX_INFLIGHT = 8;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let inflight = 0;

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

/**
 * Best-effort, per-instance throttle. On serverless this only bounds a single
 * function instance — pair it with edge/WAF limits for real protection — but it
 * stops a single client from hammering the proxy in one burst.
 */
function rateLimited(request: Request): boolean {
  const now = Date.now();
  const key = clientKey(request);
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (rateBuckets.size >= RATE_MAX_KEYS) rateBuckets.clear();
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

/**
 * Unauthenticated media proxy over an allow-listed set of CDNs. Throttle per
 * client and cap concurrent upstream loads so a burst can't exhaust memory or
 * bandwidth; the process-local buffer cache is bounded separately (cache.ts).
 */
export async function proxyMedia(request: Request): Promise<Response> {
  if (rateLimited(request)) return fail(429, "Rate limited");
  if (inflight >= MAX_INFLIGHT) return fail(503, "Busy");
  inflight += 1;
  try {
    return await handleProxy(request);
  } finally {
    inflight -= 1;
  }
}

async function handleProxy(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const raw = query.get("u") || "";
  const downloadName = safeFileName(query.get("n") || "clipkeep");
  const download = query.get("dl") === "1";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Missing file", { status: 400 });
  }
  if (target.protocol !== "https:") return new Response("Missing file", { status: 400 });
  target.searchParams.delete("bytestart");
  target.searchParams.delete("byteend");

  const accept = /\.jpe?g$/i.test(downloadName)
    ? "image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5"
    : "*/*";
  const range = download ? null : request.headers.get("range");
  const openEnded = !range || /^bytes=0-$/i.test(range.trim());

  if (!openEnded && !fullLoads.has(`${accept}\n${target.toString()}`)) {
    try {
      const upstream = await fetchAllowed(target, range, accept);
      const type = contentType(upstream);
      const expired = upstream.status === 403 || upstream.status === 410 || htmlType(type);
      if (expired || upstream.status === 404 || upstream.status === 429) {
        await upstream.body?.cancel().catch(() => undefined);
        const status = expired ? (upstream.status === 410 ? 410 : 403) : upstream.status;
        return fail(status, status === 429 ? "Rate limited" : "The file link expired.");
      }
      if ((upstream.ok || upstream.status === 206) && type && !htmlType(type)) {
        const headers = new Headers();
        headers.set("Content-Type", type);
        headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
        headers.set("Cache-Control", "private, max-age=120");
        const length = upstream.headers.get("content-length");
        const contentRange = upstream.headers.get("content-range");
        if (length) headers.set("Content-Length", length);
        if (contentRange) headers.set("Content-Range", contentRange);
        headers.set("Content-Disposition", `inline; filename="${downloadName}"`);
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      await upstream.body?.cancel().catch(() => undefined);
    } catch {
      /* fall through to a full fetch */
    }
  }

  try {
    const stored = await loadFullOnce(target, accept);
    return fileResponse(stored.bytes, stored.type, downloadName, download, range);
  } catch (error) {
    if (error instanceof UpstreamStatus) return fail(error.status, error.message);
    const message = error instanceof Error ? error.message : "";
    if (message === "large") {
      try {
        const upstream = await fetchAllowed(target, null, accept);
        const type = contentType(upstream);
        if (upstream.status === 403 || upstream.status === 410 || htmlType(type)) {
          await upstream.body?.cancel().catch(() => undefined);
          return fail(upstream.status === 410 ? 410 : 403, "The file link expired.");
        }
        if (upstream.status === 429) {
          await upstream.body?.cancel().catch(() => undefined);
          return fail(429, "Rate limited");
        }
        if ((!upstream.ok && upstream.status !== 206) || !type || htmlType(type)) {
          await upstream.body?.cancel().catch(() => undefined);
          return fail(upstream.status || 502, "Download failed");
        }
        const headers = new Headers();
        headers.set("Content-Type", type || "application/octet-stream");
        const length = upstream.headers.get("content-length");
        if (length) headers.set("Content-Length", length);
        headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(upstream.body, { status: 200, headers });
      } catch (streamError) {
        if (streamError instanceof UpstreamStatus) return fail(streamError.status, streamError.message);
        const text = streamError instanceof Error ? streamError.message : "Download failed";
        return fail(502, text);
      }
    }
    return fail(502, message || "Download failed");
  }
}
