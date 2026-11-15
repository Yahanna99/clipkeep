/**
 * Download-progress plumbing for the prepare flow.
 *
 * The media proxy forwards the upstream Content-Length, so while a file is
 * being fetched the browser can count bytes as they arrive instead of
 * sitting on a spinner. When a response carries no Content-Length there is
 * no honest percentage — callers get `total: null` and must show bytes
 * downloaded only, never a made-up %.
 */

export interface ProgressReport {
  loaded: number;
  /** Total bytes, or null when the response gave no Content-Length. */
  total: number | null;
  /** True on the final report, once the body is fully read. */
  done?: boolean;
}

export type ProgressCallback = (report: ProgressReport) => void;

export interface ProgressSnapshot {
  loaded: number;
  /** Aggregate total, or null while any in-flight file's size is unknown. */
  total: number | null;
  /** 0–100, or null when the total isn't known yet. Never fabricated. */
  percent: number | null;
}

export function parseContentLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function concatChunks(chunks: Uint8Array[], totalLength?: number): Uint8Array {
  const length = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a fetch Response body chunk by chunk, reporting progress as bytes
 * land, and return the assembled bytes — the same bytes `arrayBuffer()`
 * would have produced. Falls back to `arrayBuffer()` when the body can't
 * be streamed (no reader), reporting a single completed report.
 */
export async function readResponseBytes(response: Response, onProgress?: ProgressCallback): Promise<Uint8Array> {
  const total = parseContentLength(response.headers.get("content-length"));
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ loaded: buffer.byteLength, total: total ?? buffer.byteLength, done: true });
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress?.({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ loaded, total });
    }
  }
  onProgress?.({ loaded, total, done: true });
  return concatChunks(chunks, loaded);
}

interface ProgressEntry {
  loaded: number;
  total: number | null;
  done: boolean;
}

/**
 * Aggregates per-file progress reports (keyed by file id) into one snapshot
 * for the whole prepare run, which may fetch up to two files at once.
 * A file whose size is unknown keeps the aggregate total unknown until it
 * finishes — at that point its loaded count *is* its size.
 */
export function createProgressTracker() {
  const entries = new Map<string, ProgressEntry>();
  return {
    report(id: string, report: ProgressReport) {
      const previous = entries.get(id);
      entries.set(id, {
        // A retry restarts a file's byte count; reports are absolute, so a
        // plain overwrite is correct and never double-counts.
        loaded: report.loaded,
        total: report.total ?? previous?.total ?? null,
        done: report.done ?? previous?.done ?? false,
      });
    },
    snapshot(): ProgressSnapshot {
      let loaded = 0;
      let total = 0;
      let totalKnown = entries.size > 0;
      for (const entry of entries.values()) {
        loaded += entry.loaded;
        const effective = entry.total ?? (entry.done ? entry.loaded : null);
        if (effective == null) totalKnown = false;
        else total += effective;
      }
      const knownTotal = totalKnown ? total : null;
      return {
        loaded,
        total: knownTotal,
        percent: knownTotal != null && knownTotal > 0 ? Math.min(100, (loaded / knownTotal) * 100) : null,
      };
    },
    reset() {
      entries.clear();
    },
  };
}

export type ProgressTracker = ReturnType<typeof createProgressTracker>;

/** "12.3 MB" — one decimal, matching the compact progress label. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Label for the progress bar: a real % when known, bytes-only otherwise. */
export function progressLabel(snapshot: ProgressSnapshot): string {
  if (snapshot.percent != null && snapshot.total != null) {
    return `${Math.floor(snapshot.percent)}% · ${formatMegabytes(snapshot.loaded)} of ${formatMegabytes(snapshot.total)}`;
  }
  return `${formatMegabytes(snapshot.loaded)} downloaded`;
}
