/**
 * Small bounded, byte-aware cache for the media proxy.
 *
 * Both server-side caches in the clip pipeline are process-local and were
 * previously unbounded `Map`s: the full-file buffer cache held every distinct
 * upstream URL at up to MAX_BYTES (48 MB) for the whole TTL, and the resolve
 * cache held every distinct post forever. Because the cache key includes the
 * request URL verbatim, a caller could mint arbitrary distinct keys against a
 * single allowed CDN file and pin many copies in memory — enough to exhaust a
 * serverless function. This bounds total retained bytes *and* entry count,
 * evicting least-recently-used entries first.
 */

export interface ByteLruOptions {
  /** Hard cap on retained entries. */
  maxEntries: number;
  /** Hard cap on total retained bytes across all entries. */
  maxBytes: number;
  /** Entry lifetime in milliseconds. */
  ttlMs: number;
}

interface Entry<V> {
  value: V;
  bytes: number;
  at: number;
}

export class ByteLru<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly opts: ByteLruOptions;
  private bytes = 0;

  constructor(opts: ByteLruOptions) {
    this.opts = opts;
  }

  /** Remove oldest entries until both caps are satisfied. */
  private evict(): void {
    while (this.map.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.opts.ttlMs) {
      this.delete(key);
      return undefined;
    }
    // Refresh recency (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Like `get`, but does not refresh recency or check the TTL — identity only. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, bytes = 0): void {
    this.delete(key);
    this.map.set(key, { value, bytes, at: Date.now() });
    this.bytes += bytes;
    this.evict();
  }

  /**
   * Re-account an entry's byte weight once its size is known (e.g. after a
   * cached promise resolves), and restart its TTL from now.
   */
  weigh(key: string, bytes: number): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.bytes += bytes - entry.bytes;
    entry.bytes = bytes;
    entry.at = Date.now();
    this.evict();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.bytes -= entry.bytes;
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
