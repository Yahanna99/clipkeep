import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ByteLru } from "./cache.ts";

const big = { maxEntries: 100, maxBytes: 1_000_000, ttlMs: 10_000 };

describe("ByteLru", () => {
  it("evicts the oldest entry once the count cap is exceeded", () => {
    const cache = new ByteLru<number>({ ...big, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
  });

  it("evicts once the byte cap is exceeded", () => {
    const cache = new ByteLru<number>({ ...big, maxBytes: 10 });
    cache.set("a", 1, 6);
    cache.set("b", 2, 6);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.byteSize, 6);
  });

  it("accounts bytes added later via weigh() and evicts to fit", () => {
    const cache = new ByteLru<number>({ ...big, maxBytes: 10 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.weigh("a", 8);
    cache.weigh("b", 8);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.byteSize, 8);
  });

  it("expires entries after the TTL", async () => {
    const cache = new ByteLru<number>({ ...big, ttlMs: 1 });
    cache.set("a", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.size, 0);
  });

  it("refreshes recency on get so hot keys survive", () => {
    const cache = new ByteLru<number>({ ...big, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
  });

  it("does not refresh recency on peek", () => {
    const cache = new ByteLru<number>({ ...big, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.peek("a");
    cache.set("c", 3);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
  });
});
