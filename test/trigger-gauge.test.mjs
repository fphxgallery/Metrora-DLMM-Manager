import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The triggers panel's distance gauge. Client code, so there is no `dist/` to
// import -- it is transformed here with the esbuild that vite already ships in
// client/node_modules. Worth the seam: a marker drawn at the wrong offset still
// looks like a marker, so this is arithmetic that cannot be reviewed by eye.

const require = createRequire(import.meta.url);
let gaugeGeometry;

try {
  const esbuild = require("../client/node_modules/esbuild/lib/main.js");
  const src = readFileSync(new URL("../client/src/gauge.ts", import.meta.url), "utf8");
  const { code } = esbuild.transformSync(src, { loader: "ts", format: "esm" });
  ({ gaugeGeometry } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`));
} catch (e) {
  // Skipping loudly rather than passing quietly: a green run must not mean
  // "client deps were not installed".
  console.error(`trigger-gauge: cannot load client/src/gauge.ts (${e.message}) -- run \`npm run install:all\``);
  process.exit(1);
}

test("both thresholds span the track and the reading lands between them", () => {
  const g = gaugeGeometry(-0.43, -1, 5);
  assert.equal(g.lo, -1);
  assert.equal(g.hi, 5);
  // (-0.43 - -1) / 6 = 0.095
  assert.ok(Math.abs(g.pct - 9.5) < 1e-9, `pct was ${g.pct}`);
  assert.equal(g.beyond, null);
});

test("the marker sits at the ends when the reading is exactly on a threshold", () => {
  assert.equal(gaugeGeometry(-1, -1, 5).pct, 0);
  assert.equal(gaugeGeometry(5, -1, 5).pct, 100);
  assert.equal(gaugeGeometry(-1, -1, 5).beyond, null, "on the stop is not past it");
  assert.equal(gaugeGeometry(5, -1, 5).beyond, null);
});

test("a reading past its stop is pinned AND flagged", () => {
  // The case the panel exists for. Clamping alone would render a loss of -8%
  // identically to one sitting right on the -1% stop.
  const g = gaugeGeometry(-8, -1, 5);
  assert.equal(g.pct, 0);
  assert.equal(g.beyond, "lo");
});

test("a reading past its target is pinned at the other end", () => {
  const g = gaugeGeometry(19, -1, 5);
  assert.equal(g.pct, 100);
  assert.equal(g.beyond, "hi");
});

test("break-even is placed proportionally, not at the middle", () => {
  const g = gaugeGeometry(0, -1, 5);
  // Zero is one sixth along a track running -1..5, nowhere near halfway.
  assert.ok(Math.abs(g.zeroPct - 100 / 6) < 1e-9, `zeroPct was ${g.zeroPct}`);
});

test("a stop with no target runs to break-even, with no zero line", () => {
  const g = gaugeGeometry(-0.5, -2, null);
  assert.equal(g.lo, -2);
  assert.equal(g.hi, 0);
  assert.equal(g.pct, 75);
  // Zero IS the right edge here; a line drawn on the border reads as the border.
  assert.equal(g.zeroPct, null);
});

test("a target with no stop starts at break-even", () => {
  const g = gaugeGeometry(2, null, 8);
  assert.equal(g.lo, 0);
  assert.equal(g.hi, 8);
  assert.equal(g.pct, 25);
  assert.equal(g.zeroPct, null);
});

test("a profitable position on a stop-only gauge pins at the top", () => {
  // Common and easy to get wrong: with no target the track ends at zero, so
  // every winning reading is off the end.
  const g = gaugeGeometry(3, -2, null);
  assert.equal(g.pct, 100);
  assert.equal(g.beyond, "hi");
});

test("no thresholds means no gauge", () => {
  assert.equal(gaugeGeometry(1.5, null, null), null);
});

test("a degenerate span means no gauge rather than a divide by zero", () => {
  // Config validation forbids these, but a NaN width would render as a bar with
  // the marker gone rather than as an obvious fault.
  assert.equal(gaugeGeometry(0, 5, 5), null);
  assert.equal(gaugeGeometry(0, 5, -1), null);
  assert.equal(gaugeGeometry(0, 0, null), null, "a zero stop leaves no track");
});

test("a missing reading still draws the track, with no marker", () => {
  const g = gaugeGeometry(null, -1, 5);
  assert.notEqual(g, null);
  assert.equal(g.pct, null);
  assert.equal(g.beyond, null);
});

test("a non-finite reading is treated as absent", () => {
  assert.equal(gaugeGeometry(NaN, -1, 5).pct, null);
  assert.equal(gaugeGeometry(Infinity, -1, 5).pct, null);
});

test("usd thresholds work the same — the geometry has no unit", () => {
  const g = gaugeGeometry(-9.15, -20, 40);
  assert.ok(Math.abs(g.pct - (10.85 / 60) * 100) < 1e-9, `pct was ${g.pct}`);
  assert.equal(g.beyond, null);
});
