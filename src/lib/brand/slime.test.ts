import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import opentype from "opentype.js";
import {
  DESKTOP_FONT_SIZE,
  LOGO_DELAY_MAX_MS,
  LOGO_DELAY_MIN_MS,
  MOBILE_FONT_SIZE,
  PLAY_MIN_MS,
  WORD,
  advanceSim,
  buildBrandFrame,
  createSim,
  nextLogoDelayMs,
  poseOf,
  randomPlayMs,
  sampleAt,
  type Track,
} from "./slime.ts";

function loadFont() {
  const font = opentype.parse(readFileSync(join(process.cwd(), "public/fonts/TitanOne-Regular.ttf")).buffer);
  return font;
}

function lineTrack(): Track {
  const count = 40;
  const spacing = 4;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const letters = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) xs[i] = i * spacing;
  return {
    xs,
    ys,
    letters,
    count,
    spacing,
    length: (count - 1) * spacing,
    speed: 400,
  };
}

describe("clipkeep slime outline", () => {
  const font = loadFont();

  it("uses an upright heavy face for the word clipkeep", () => {
    assert.equal(WORD, "clipkeep");
    assert.equal(font.tables.post.italicAngle, 0);
    assert.match(font.getEnglishName("fullName"), /Titan/i);
  });

  it("follows each real letter from left to right", () => {
    for (const fontSize of [MOBILE_FONT_SIZE, DESKTOP_FONT_SIZE]) {
      const frame = buildBrandFrame(font, fontSize);
      assert.equal(frame.d.includes("NaN"), false);
      assert.ok(frame.w > fontSize && frame.h > fontSize * 0.45);
      assert.ok(frame.h < fontSize * 1.7);
      const means: number[] = [];
      for (let letter = 0; letter < WORD.length; letter += 1) {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < frame.track.count; i += 1) {
          if (frame.track.letters[i] !== letter) continue;
          sum += frame.track.xs[i];
          n += 1;
          assert.ok(Number.isFinite(frame.track.xs[i]) && Number.isFinite(frame.track.ys[i]));
          assert.ok(frame.track.xs[i] >= -2 && frame.track.xs[i] <= frame.w + 2);
          assert.ok(frame.track.ys[i] >= -2 && frame.track.ys[i] <= frame.h + 2);
        }
        assert.ok(n > 24, `letter ${WORD[letter]} had ${n} samples`);
        means.push(sum / n);
      }
      for (let i = 0; i < means.length - 1; i += 1) {
        assert.ok(means[i] < means[i + 1], `${WORD[i]} should sit left of ${WORD[i + 1]}`);
      }
      let maxGap = 0;
      for (let i = 1; i < frame.track.count; i += 1) {
        const gap = Math.hypot(
          frame.track.xs[i] - frame.track.xs[i - 1],
          frame.track.ys[i] - frame.track.ys[i - 1],
        );
        if (gap > maxGap) maxGap = gap;
      }
      assert.ok(maxGap < frame.track.spacing * 3.2, `gap ${maxGap}`);
    }
  });
});

describe("slime motion", () => {
  it("traces, bounces off, plays, then returns to the start", () => {
    const track = lineTrack();
    let sim = createSim(PLAY_MIN_MS);
    const target = { x: 20, y: -30, arc: 18, wobble: 6 };
    const hooks = {
      launchTarget: () => target,
      nextPlayMs: () => PLAY_MIN_MS,
    };
    const stepUntil = (phase: "trace" | "launch" | "play" | "return") => {
      for (let i = 0; i < 800 && sim.phase !== phase; i += 1) sim = advanceSim(sim, track, 16, hooks);
      assert.equal(sim.phase, phase);
    };
    stepUntil("launch");
    assert.equal(sim.toX, target.x);
    assert.equal(sim.toY, target.y);
    const launched = poseOf(sim, track, 0);
    assert.ok(Math.abs(launched.x - track.xs[track.count - 1]) < 1);

    stepUntil("play");
    const mid = poseOf({ ...sim, elapsed: PLAY_MIN_MS / 2 }, track, 1000);
    assert.equal(mid.phase, "play");
    assert.ok(mid.burst > 0.5);

    stepUntil("return");
    assert.equal(sim.toX, track.xs[0]);

    stepUntil("trace");
    assert.equal(sim.index, 0);
    const sample = sampleAt(track, 0);
    assert.equal(sample.x, 0);
  });

  it("keeps the logo bounce on a 10–15s cadence", () => {
    assert.equal(nextLogoDelayMs(() => 0), LOGO_DELAY_MIN_MS);
    assert.equal(nextLogoDelayMs(() => 1), LOGO_DELAY_MAX_MS);
    for (let i = 0; i < 10; i += 1) {
      const delay = nextLogoDelayMs(() => i / 10);
      assert.ok(delay >= LOGO_DELAY_MIN_MS && delay <= LOGO_DELAY_MAX_MS);
      const play = randomPlayMs(() => i / 10);
      assert.ok(play >= 1100 && play <= 1550);
    }
  });
});
