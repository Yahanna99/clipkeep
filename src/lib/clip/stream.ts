/**
 * Stream-mode decisions for the media proxy (`/api/file?stream=1`).
 *
 * Kept import-free so the rules can be unit-tested directly — files.ts
 * itself pulls in server-only modules the test harness can't load.
 * The checks mirror the proxy's existing >MAX_BYTES streaming branch:
 * expired links (403/410 or an HTML error page in place of media) and
 * rate limits are rejected with their real status, anything else that
 * isn't a usable media response is a plain download failure.
 */

export interface StreamRejection {
  status: number;
  message: string;
}

/** Returns why a stream-mode upstream response must be rejected, or null to pass it through. */
export function streamRejection(status: number, type: string, isHtmlType: boolean): StreamRejection | null {
  if (status === 403 || status === 410 || isHtmlType) {
    return { status: status === 410 ? 410 : 403, message: "The file link expired." };
  }
  if (status === 429) return { status: 429, message: "Rate limited" };
  // A 200 with no media type isn't a file at all — report it as a bad
  // upstream response, not a successful download of the error text.
  if (!type) return { status: 502, message: "Download failed" };
  if (!(status >= 200 && status < 300) && status !== 206) {
    return { status: status || 502, message: "Download failed" };
  }
  return null;
}

/** Headers for a streamed pass-through response: same shape the buffered path sends, minus range support. */
export function streamResponseHeaders(type: string, contentLength: string | null, downloadName: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", type);
  headers.set("Cache-Control", "private, max-age=120");
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set("Content-Disposition", `inline; filename="${downloadName}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}
