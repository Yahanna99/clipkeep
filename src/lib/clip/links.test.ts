import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPostUrl, isConcretePost, isInstagramLink, platformOf } from "./links.ts";

const TIKTOK_VIDEO = "https://www.tiktok.com/@someuser/video/1234567890123456789";
const X_POST = "https://x.com/someuser/status/1234567890123";
const INSTAGRAM_POST = "https://www.instagram.com/p/ABCdef123_-/";
const INSTAGRAM_REEL = "https://www.instagram.com/reel/ABCdef123_-/";

describe("platformOf", () => {
  it("detects TikTok links", () => {
    assert.equal(platformOf(TIKTOK_VIDEO), "tiktok");
    assert.equal(platformOf("https://vm.tiktok.com/AbCdEf123/"), "tiktok");
  });

  it("detects X links", () => {
    assert.equal(platformOf(X_POST), "x");
    assert.equal(platformOf("https://twitter.com/someuser/status/1234567890123"), "x");
  });

  it("does not treat Instagram links as a supported platform", () => {
    assert.equal(platformOf(INSTAGRAM_POST), null);
    assert.equal(platformOf(INSTAGRAM_REEL), null);
    assert.equal(platformOf("https://www.instagram.com/stories/someuser/123456789/"), null);
  });
});

describe("isInstagramLink", () => {
  it("recognizes Instagram post, reel, and story links", () => {
    assert.equal(isInstagramLink(INSTAGRAM_POST), true);
    assert.equal(isInstagramLink(INSTAGRAM_REEL), true);
    assert.equal(isInstagramLink("https://www.instagram.com/stories/someuser/123456789/"), true);
    assert.equal(isInstagramLink("https://instagr.am/p/ABCdef123_-/"), true);
  });

  it("recognizes an Instagram link inside share text", () => {
    assert.equal(isInstagramLink(`Check this out ${INSTAGRAM_REEL} via Instagram`), true);
  });

  it("does not flag TikTok or X links", () => {
    assert.equal(isInstagramLink(TIKTOK_VIDEO), false);
    assert.equal(isInstagramLink(X_POST), false);
  });
});

describe("extractPostUrl", () => {
  it("extracts TikTok and X links from share text", () => {
    assert.equal(extractPostUrl(`watch this ${TIKTOK_VIDEO} now`), TIKTOK_VIDEO);
    assert.equal(extractPostUrl(`watch this ${X_POST} now`), X_POST);
  });

  it("never extracts an Instagram link", () => {
    assert.equal(extractPostUrl(INSTAGRAM_POST), null);
    assert.equal(extractPostUrl(`watch this ${INSTAGRAM_REEL} now`), null);
  });
});

describe("isConcretePost", () => {
  it("accepts TikTok videos and X posts", () => {
    assert.equal(isConcretePost(TIKTOK_VIDEO), true);
    assert.equal(isConcretePost(X_POST), true);
  });

  it("rejects Instagram links", () => {
    assert.equal(isConcretePost(INSTAGRAM_POST), false);
    assert.equal(isConcretePost(INSTAGRAM_REEL), false);
  });
});
