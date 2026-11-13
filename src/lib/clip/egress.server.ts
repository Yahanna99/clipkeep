import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
];

const pinnedSlot = new AsyncLocalStorage<number>();

function proxyList(): string[] {
  return (process.env.CLIPKEEP_IG_PROXIES || process.env.HTTPS_PROXY || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));
}

let slot = 0;

export function rotateEgress(): void {
  const proxies = proxyList();
  slot = (slot + 1) % Math.max(proxies.length, AGENTS.length, 1);
}

/** Keep one egress identity for a cookie + GraphQL pair. */
export function runWithEgress<T>(work: () => Promise<T>): Promise<T> {
  return pinnedSlot.run(slot, work);
}

function current(): { ua: string; proxy: string | null } {
  const proxies = proxyList();
  const index = pinnedSlot.getStore() ?? slot;
  return {
    ua: AGENTS[index % AGENTS.length],
    proxy: proxies.length ? proxies[index % proxies.length] : null,
  };
}

function bodyBuffer(body: RequestInit["body"]): Buffer | null {
  if (!body) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

function fetchViaProxy(targetUrl: string, init: RequestInit, proxyUrl: string): Promise<Response> {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const headers = new Headers(init.headers);
  const payload = bodyBuffer(init.body);
  if (payload && !headers.has("content-length")) headers.set("content-length", String(payload.byteLength));
  const proxyHeaders: Record<string, string> = {};
  if (proxy.username) {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    proxyHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  const transport = proxy.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const connect = transport.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:443`,
      headers: proxyHeaders,
    });
    const fail = (error: unknown) => {
      connect.destroy();
      reject(error instanceof Error ? error : new Error("Proxy connection failed"));
    };
    init.signal?.addEventListener("abort", () => fail(new Error("The download was aborted")), { once: true });
    connect.on("error", fail);
    connect.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy refused the tunnel (${response.statusCode})`));
        return;
      }
      const req = https.request(
        {
          host: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: init.method || "GET",
          headers: Object.fromEntries(headers.entries()),
          socket,
          agent: false,
        } as https.RequestOptions,
        (upstream) => {
          const stream = Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(upstream.headers)) {
            if (value === undefined) continue;
            responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(new Response(stream, { status: upstream.statusCode || 502, headers: responseHeaders }));
        },
      );
      req.on("error", fail);
      if (payload) req.write(payload);
      req.end();
    });
    connect.end();
  });
}

/** Instagram fetches rotate browser identity and, when configured, residential proxies. */
export async function egressFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const egress = current();
  const headers = new Headers(init.headers);
  // Only supply the rotated UA when the caller didn't set one. Several IG
  // endpoints (the mobile media/info API, the mobile oembed) require their own
  // UA; clobbering it here made those fallbacks fail intermittently.
  if (!headers.has("user-agent")) headers.set("User-Agent", egress.ua);
  if (!egress.proxy) return fetch(url, { ...init, headers });
  const proxy = egress.proxy;
  try {
    return await fetchViaProxy(url, { ...init, headers }, proxy);
  } catch {
    // A dead proxy must not silently degrade to a direct request — the
    // direct (datacenter-IP) path is exactly what Instagram blocks, so the
    // failure would otherwise masquerade as more blocking. Log the proxy
    // host only, never its credentials.
    let proxyHost = "configured proxy";
    try {
      proxyHost = new URL(proxy).host;
    } catch {
      /* keep the generic label */
    }
    console.warn(`[clipkeep] egress proxy ${proxyHost} failed; falling back to a direct request`);
    return fetch(url, { ...init, headers });
  }
}
