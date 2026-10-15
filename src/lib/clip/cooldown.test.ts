import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cooldown } from "./cooldown.ts";

describe("Cooldown", () => {
  it("is inactive until tripped", () => {
    const cooldown = new Cooldown();
    assert.equal(cooldown.active(1_000), false);
    assert.equal(cooldown.remainingMs(1_000), 0);
  });

  it("stays active for the whole window and then expires", () => {
    const cooldown = new Cooldown();
    cooldown.trip(1_000, 5_000);
    assert.equal(cooldown.active(5_000), true);
    assert.equal(cooldown.remainingMs(5_500), 500);
    assert.equal(cooldown.active(6_000), false);
    assert.equal(cooldown.remainingMs(6_001), 0);
  });

  it("never shortens an existing window", () => {
    const cooldown = new Cooldown();
    cooldown.trip(5_000, 0);
    cooldown.trip(1_000, 1_000);
    assert.equal(cooldown.active(4_999), true);
    assert.equal(cooldown.active(5_000), false);
  });

  it("releases immediately on clear()", () => {
    const cooldown = new Cooldown();
    cooldown.trip(5_000, 0);
    cooldown.clear();
    assert.equal(cooldown.active(1), false);
  });
});
