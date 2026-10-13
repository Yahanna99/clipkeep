import type { Platform } from "./types";

const TIKTOK = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "www.vm.tiktok.com",
  "www.vt.tiktok.com",
]);

const INSTAGRAM = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

const REDDIT = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "m.reddit.com",
  "np.reddit.com",
  "redd.it",
  "www.redd.it",
  "v.redd.it",
]);

const XHOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "vxtwitter.com",
  "fxtwitter.com",
  "fixupx.com",
  "t.co",
]);

const BARE =
  /^(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|instagram\.com|instagr\.am|x\.com|twitter\.com)\b/i;

const EMBEDDED =
  /(?:^|[\s<(])((?:www\.)?(?:(?:vm|vt)\.)?tiktok\.com\/[^\s<>"']+|instagram\.com\/[^\s<>"']+|instagr\.am\/[^\s<>"']+|x\.com\/[^\s<>"']+|twitter\.com\/[^\s<>"']+|t\.co\/[^\s<>"']+)/gi;

export function ensureHttp(raw: string): string {
  let value = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (!value) return value;
  if (!/^https?:\/\//i.test(value) && BARE.test(value)) value = `https://${value}`;
  return value;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase();
}

export function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return REDDIT.has(host) || host.endsWith(".reddit.com") || host.endsWith(".redd.it");
}

export function platformOf(raw: string): Platform | null {
  let url: URL;
  try {
    url = new URL(ensureHttp(raw));
  } catch {
    return null;
  }
  const host = hostOf(url);
  if (TIKTOK.has(host) || host.endsWith(".tiktok.com")) return "tiktok";
  if (INSTAGRAM.has(host) || host.endsWith(".instagram.com")) return "instagram";
  if (XHOSTS.has(host) || host.endsWith(".twitter.com") || host.endsWith(".x.com")) return "x";
  return null;
}

export function instagramShortcode(raw: string): string | null {
  try {
    const url = new URL(ensureHttp(raw));
    const path = url.pathname;
    const direct = path.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (direct) return direct[1];
    const share = path.match(/\/share\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
    if (share) return share[1];
    return null;
  } catch {
    return null;
  }
}

export function isInstagramStory(raw: string): boolean {
  try {
    return /\/stories\//i.test(new URL(ensureHttp(raw)).pathname);
  } catch {
    return false;
  }
}

function tiktokConcrete(raw: string): boolean {
  try {
    const url = new URL(ensureHttp(raw));
    const path = url.pathname;
    if (/\/(?:video|photo|v)\/\d{5,}/i.test(path)) return true;
    if (/^\/@[^/]+\/story(?:\/\d{5,})?\/?$/i.test(path)) return true;
    const share = path.match(/^\/t\/([A-Za-z0-9]+)/i);
    if (share && share[1].length >= 5) return true;
    const host = url.hostname.toLowerCase();
    if (
      (host.includes("vm.tiktok") || host.includes("vt.tiktok")) &&
      path.replace(/\//g, "").length >= 5
    ) {
      return true;
    }
    return path.startsWith("/share/") && path.length > 8;
  } catch {
    return false;
  }
}

export function isConcretePost(raw: string): boolean {
  const platform = platformOf(raw);
  if (platform === "tiktok") return tiktokConcrete(raw);
  if (platform === "instagram") {
    if (isInstagramStory(raw)) return false;
    const code = instagramShortcode(raw);
    return !!code && code.length >= 5;
  }
  if (platform === "x") {
    try {
      const url = new URL(ensureHttp(raw));
      if (/\/status\/\d+/.test(url.pathname)) return true;
      return url.hostname.replace(/^www\./, "").toLowerCase() === "t.co" && url.pathname.length > 2;
    } catch {
      return false;
    }
  }
  return false;
}

function trimTail(value: string): string {
  return value.replace(/[.,;:!?)\]>]+$/g, "");
}

export function extractPostUrl(input: string): string | null {
  const text = input.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ").trim();
  if (!text) return null;
  if (!/\s/.test(text)) {
    const single = ensureHttp(text);
    if (platformOf(single)) return single;
  }
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) found.push(match[0]);
  for (const match of text.matchAll(EMBEDDED)) {
    if (match[1]) found.push(match[1]);
  }
  for (const item of found) {
    const url = ensureHttp(trimTail(item));
    if (platformOf(url) && isConcretePost(url)) return url;
  }
  for (const item of found) {
    const url = ensureHttp(trimTail(item));
    if (platformOf(url)) return url;
  }
  return null;
}

export function slug(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 42);
  return cleaned || fallback;
}
