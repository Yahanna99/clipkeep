import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { streamRejection, streamResponseHeaders } from "./stream.ts";

describe("streamRejection", () => {
  it("passes a healthy media response through", () => {
    assert.equal(streamRejection(200, "video/mp4", false), null);
    assert.equal(streamRejection(206, "video/mp4", false), null);
  });

  it("rejects expired links with their real status", () => {
    assert.deepEqual(streamRejection(403, "video/mp4", false), { status: 403, message: "The file link expired." });
    assert.deepEqual(streamRejection(410, "video/mp4", false), { status: 410, message: "The file link expired." });
  });

  it("treats an HTML page in place of media as an expired link", () => {
    assert.deepEqual(streamRejection(200, "text/html", true), { status: 403, message: "The file link expired." });
  });

  it("rejects rate limits as 429", () => {
    assert.deepEqual(streamRejection(429, "video/mp4", false), { status: 429, message: "Rate limited" });
  });

  it("rejects other failures and typeless responses as download failures", () => {
    assert.deepEqual(streamRejection(404, "video/mp4", false), { status: 404, message: "Download failed" });
    assert.deepEqual(streamRejection(500, "video/mp4", false), { status: 500, message: "Download failed" });
    assert.deepEqual(streamRejection(200, "", false), { status: 502, message: "Download failed" });
  });
});

describe("streamResponseHeaders", () => {
  it("forwards Content-Length when the upstream sent one", () => {
    const headers = streamResponseHeaders("video/mp4", "12345", "clip.mp4");
    assert.equal(headers.get("Content-Type"), "video/mp4");
    assert.equal(headers.get("Content-Length"), "12345");
    assert.equal(headers.get("Content-Disposition"), 'inline; filename="clip.mp4"');
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  });

  it("omits Content-Length when the upstream sent none (chunked)", () => {
    const headers = streamResponseHeaders("video/mp4", null, "clip.mp4");
    assert.equal(headers.get("Content-Length"), null);
  });
});
