import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allTargetsOf, videoGroups } from "./targets.ts";
import type { ClipMedia, Variant } from "./types.ts";

function variant(partial: Partial<Variant> & { id: string }): Variant {
  return { kind: "video", label: partial.id, url: `https://example.com/${partial.id}`, ext: "mp4", ...partial };
}

function media(variants: Variant[]): ClipMedia {
  return { platform: "tiktok", sourceUrl: "https://tiktok.com/@x/video/1", title: "TikTok", author: "x", variants };
}

describe("videoGroups", () => {
  it("keeps ungrouped videos separate and picks the tallest per group", () => {
    const groups = videoGroups(
      media([
        variant({ id: "live-video-1", height: 960 }),
        variant({ id: "live-video-2", height: 960 }),
        variant({ id: "video-hd", group: "video", height: 1080, bitrate: 5000 }),
        variant({ id: "video-sd", group: "video", height: 720, bitrate: 2000 }),
      ]),
    );
    assert.equal(groups.length, 3);
    assert.equal(groups[2][0].id, "video-hd");
    assert.equal(groups[2][1].id, "video-sd");
  });
});

describe("allTargetsOf", () => {
  it("returns every photo plus every Live Photo motion video", () => {
    const targets = allTargetsOf(
      media([
        variant({ id: "photo-1", kind: "image", ext: "jpg", index: 1 }),
        variant({ id: "live-video-1", index: 1 }),
        variant({ id: "photo-2", kind: "image", ext: "jpg", index: 2 }),
        variant({ id: "live-video-2", index: 2 }),
        variant({ id: "photo-3", kind: "image", ext: "jpg", index: 3 }),
        variant({ id: "live-video-3", index: 3 }),
      ]),
    );
    assert.deepEqual(
      targets.map((item) => item.id),
      ["photo-1", "photo-2", "photo-3", "live-video-1", "live-video-2", "live-video-3"],
    );
  });

  it("saves a multi-quality video once, at the best quality", () => {
    const targets = allTargetsOf(
      media([
        variant({ id: "video-sd", group: "video", height: 720 }),
        variant({ id: "video-hd", group: "video", height: 1080 }),
        variant({ id: "photo-1", kind: "image", ext: "jpg" }),
      ]),
    );
    assert.deepEqual(
      targets.map((item) => item.id),
      ["photo-1", "video-hd"],
    );
  });

  it("includes audio tracks and handles an empty post", () => {
    const targets = allTargetsOf(
      media([variant({ id: "audio-1", kind: "audio", ext: "mp3", label: "Audio" })]),
    );
    assert.deepEqual(
      targets.map((item) => item.id),
      ["audio-1"],
    );
    assert.deepEqual(allTargetsOf(media([])), []);
  });
});
