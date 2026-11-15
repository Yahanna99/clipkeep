import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProgressTracker,
  formatMegabytes,
  parseContentLength,
  progressLabel,
  readResponseBytes,
  type ProgressReport,
} from "./progress.ts";

describe("parseContentLength", () => {
  it("parses a byte count", () => {
    assert.equal(parseContentLength("1048576"), 1048576);
  });

  it("returns null for missing or junk values", () => {
    assert.equal(parseContentLength(null), null);
    assert.equal(parseContentLength(undefined), null);
    assert.equal(parseContentLength(""), null);
    assert.equal(parseContentLength("chunked"), null);
    assert.equal(parseContentLength("-5"), null);
  });
});

describe("readResponseBytes", () => {
  it("assembles streamed chunks and reports cumulative progress", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.enqueue(new Uint8Array([6]));
        controller.close();
      },
    });
    const response = new Response(stream, { headers: { "Content-Length": "6" } });
    const reports: ProgressReport[] = [];
    const bytes = await readResponseBytes(response, (report) => reports.push(report));
    assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(
      reports.map((report) => report.loaded),
      [0, 3, 5, 6, 6],
    );
    assert.equal(reports[0].total, 6);
    assert.equal(reports[reports.length - 1].done, true);
  });

  it("reports a null total when the response has no Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9, 9]));
        controller.close();
      },
    });
    // Response strips a manually-set Content-Length only if we set one; a
    // stream body gets none, which is exactly the chunked case.
    const response = new Response(stream);
    const reports: ProgressReport[] = [];
    const bytes = await readResponseBytes(response, (report) => reports.push(report));
    assert.equal(bytes.byteLength, 2);
    assert.ok(reports.length > 0);
    assert.equal(reports[0].total, null);
  });
});

describe("createProgressTracker", () => {
  it("sums loaded and total across concurrent files", () => {
    const tracker = createProgressTracker();
    tracker.report("a", { loaded: 50, total: 100 });
    tracker.report("b", { loaded: 25, total: 100 });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.loaded, 75);
    assert.equal(snapshot.total, 200);
    assert.equal(snapshot.percent, 37.5);
  });

  it("keeps the total unknown while any in-flight file has no size", () => {
    const tracker = createProgressTracker();
    tracker.report("a", { loaded: 50, total: 100 });
    tracker.report("b", { loaded: 25, total: null });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.loaded, 75);
    assert.equal(snapshot.total, null);
    assert.equal(snapshot.percent, null);
  });

  it("treats a finished file's loaded bytes as its size", () => {
    const tracker = createProgressTracker();
    tracker.report("a", { loaded: 100, total: 100, done: true });
    tracker.report("b", { loaded: 40, total: null, done: true });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.total, 140);
    assert.equal(snapshot.percent, 100);
  });

  it("a retry's fresh report replaces, never double-counts", () => {
    const tracker = createProgressTracker();
    tracker.report("a", { loaded: 80, total: 100 });
    tracker.report("a", { loaded: 0, total: 100 });
    tracker.report("a", { loaded: 10, total: 100 });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.loaded, 10);
    assert.equal(snapshot.percent, 10);
  });

  it("reset clears everything", () => {
    const tracker = createProgressTracker();
    tracker.report("a", { loaded: 10, total: 100 });
    tracker.reset();
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.loaded, 0);
    assert.equal(snapshot.total, null);
    assert.equal(snapshot.percent, null);
  });
});

describe("progressLabel", () => {
  it("shows percent and MB when the total is known", () => {
    const label = progressLabel({ loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024, percent: 50 });
    assert.equal(label, "50% · 5.0 MB of 10.0 MB");
  });

  it("shows bytes only — no fake percent — when the total is unknown", () => {
    const label = progressLabel({ loaded: 2.5 * 1024 * 1024, total: null, percent: null });
    assert.equal(label, "2.5 MB downloaded");
    assert.ok(!label.includes("%"));
  });

  it("formats megabytes with one decimal", () => {
    assert.equal(formatMegabytes(0), "0.0 MB");
    assert.equal(formatMegabytes(48 * 1024 * 1024), "48.0 MB");
  });
});
