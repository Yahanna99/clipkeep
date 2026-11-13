import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bareMediaId } from "./links.ts";

describe("bareMediaId", () => {
  it("strips the oEmbed user-id suffix", () => {
    assert.equal(bareMediaId("4028252940677913997_26537022585"), "4028252940677913997");
  });

  it("leaves a bare media id untouched", () => {
    assert.equal(bareMediaId("4028252940677913997"), "4028252940677913997");
  });
});
