// Unit tests for the pure math, with synthetic signals. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SRGB_TO_LINEAR,
  makeLayout,
  measureFrame,
  percentile,
  weightedPercentile,
  detrend,
  findCuts,
  outliers,
  flickerIndex,
  percentFlicker,
  labelFor,
  analyze,
} from '../src/math.js';

const GRID = 4;
const NC = GRID * GRID;
const layout = makeLayout(64, 36, GRID);

// deterministic noise
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function gaussian(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Frames from a per-cell brightness function fn(cell, t, k), with multiplicative noise. */
function synth(fn, { fps = 30, seconds = 6, noise = 0.002, seed = 1, keep = () => true } = {}) {
  const r = rng(seed);
  const frames = [];
  const n = Math.round(fps * seconds);
  for (let k = 0; k < n; k++) {
    const t = k / fps;
    const cells = new Float64Array(NC);
    for (let c = 0; c < NC; c++) cells[c] = fn(c, t, k) * (1 + noise * gaussian(r));
    if (keep(k, r)) frames.push({ t, cells, valid: new Float64Array(NC).fill(1) });
  }
  return frames;
}

/** Brightness of a frame exposed for `exposure` s from time t under a light
 *  1 + depth*cos(2*pi*f*tau + phase): the camera integrates the light. */
function exposed(t, f, depth, exposure = 1 / 500, phase = 0.3) {
  const steps = 50;
  let s = 0;
  for (let i = 0; i < steps; i++) s += 1 + depth * Math.cos(2 * Math.PI * f * (t + ((i + 0.5) / steps) * exposure) + phase);
  return s / steps;
}

test('sRGB code values convert to linear light', () => {
  assert.equal(SRGB_TO_LINEAR[0], 0);
  assert.equal(SRGB_TO_LINEAR[255], 1);
  assert.ok(Math.abs(SRGB_TO_LINEAR[128] - 0.2158) < 1e-3);
  assert.ok(Math.abs(SRGB_TO_LINEAR[10] - 10 / 255 / 12.92) < 1e-9);
});

test('measureFrame: cell luminance and usable pixels (RGBA and RGB)', () => {
  const { width, height } = layout;
  const rgba = (v) => new Uint8ClampedArray(width * height * 4).fill(v);
  const gray = measureFrame(rgba(128), layout, 4);
  for (let c = 0; c < NC; c++) {
    assert.ok(Math.abs(gray.cells[c] - 0.2158) < 1e-3);
    assert.equal(gray.valid[c], 1);
  }
  assert.equal(measureFrame(rgba(5), layout, 4).valid[0], 0, 'near-black is not usable');
  assert.equal(measureFrame(rgba(255), layout, 4).valid[0], 0, 'clipped white is not usable');
  const rgb = new Uint8Array(width * height * 3).fill(128);
  assert.ok(Math.abs(measureFrame(rgb, layout, 3).cells[5] - 0.2158) < 1e-3);
  // cell areas cover the frame
  assert.equal(layout.area.reduce((a, b) => a + b, 0), width * height);
});

test('percentile and weighted percentile', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([0, 10], 25), 2.5);
  assert.equal(weightedPercentile([1, 2, 3, 4], [1, 1, 1, 1], 50), 2.5);
  // a heavy cell pulls the percentile toward it
  assert.ok(weightedPercentile([1, 10], [1, 9], 50) > 5);
});

test('steady light reads about 0 %', () => {
  const r = analyze(synth(() => 0.3, { noise: 0.003 }), layout);
  assert.ok(r.percent < 1, `percent ${r.percent}`);
  assert.equal(r.label, 'none');
  assert.equal(r.hz, null);
  assert.equal(r.usableArea, 1);
  assert.equal(r.frames, 180);
});

test('100 Hz light filmed at 30 fps reads high, with a ~10 Hz visible rhythm', () => {
  // 100 Hz mains flicker aliases to |100 - 3*30| = 10 Hz at 30 fps
  const r = analyze(synth((c, t) => 0.25 * exposed(t, 100, 0.3)), layout);
  assert.ok(r.percent > 12, `percent ${r.percent}`);
  assert.equal(r.label, 'strong');
  assert.ok(Math.abs(r.hz - 10) < 0.3, `hz ${r.hz}`);
  assert.ok(r.flickerIndex > 0.03, `flicker index ${r.flickerIndex}`);
});

test('frame-to-frame alternation is detected at half the frame rate', () => {
  // A centered moving average over an odd number of frames keeps 1/9 of a
  // frame-to-frame alternation in the trend at 30 fps, so +-8 % reads about 7.1 %.
  const r = analyze(synth((c, t, k) => 0.3 * (k % 2 ? 1.08 : 0.92)), layout);
  assert.ok(r.percent > 6.5 && r.percent < 8.5, `percent ${r.percent}`);
  assert.equal(r.label, 'visible');
  assert.ok(Math.abs(r.hz - 15) < 0.3, `hz ${r.hz}`);
});

test('slow ramps and fades (scene changes) do not read as flicker', () => {
  const ramp = analyze(synth((c, t) => 0.1 + (0.3 * t) / 6), layout);
  assert.ok(ramp.percent < 1, `ramp ${ramp.percent}`);
  // fade in from dark: 10x brighter over 2 s, then steady
  const fade = analyze(synth((c, t) => 0.04 * Math.pow(10, Math.min(t, 2) / 2)), layout);
  assert.ok(fade.percent < 1.5, `fade ${fade.percent}`);
  assert.equal(fade.label, 'none');
  // auto exposure hunting: a slow 0.5 Hz swing of +-20 %
  const hunt = analyze(synth((c, t) => 0.3 * (1 + 0.2 * Math.sin(2 * Math.PI * 0.5 * t))), layout);
  assert.ok(hunt.percent < 1.5, `hunt ${hunt.percent}`);
});

test('a hard cut is a scene change, not flicker', () => {
  const frames = synth((c, t) => (t < 3 ? 0.15 : 0.5));
  const y = frames.map((f) => f.cells[0]);
  assert.deepEqual(findCuts(frames.map((f) => f.t), y), [90]);
  const r = analyze(frames, layout);
  assert.ok(r.percent < 1.5, `percent ${r.percent}`);
});

test('motion through one cell for part of the clip is not flicker', () => {
  // choppy changes of up to +-40 % in one cell for 2 s (someone walking past), then steady
  const r0 = rng(7);
  let held = 1;
  const r = analyze(
    synth((c, t, k) => {
      if (c !== 5) return 0.3;
      if (k % 2 === 0) held = 1 + 0.8 * (r0() - 0.5);
      return t > 0.5 && t < 2.5 ? 0.3 * held : 0.3;
    }),
    layout,
  );
  assert.ok(r.regions[5].percent > 8, `cell ${r.regions[5].percent}`); // the cell itself changes
  assert.ok(r.regions[5].sustained < 2, `sustained ${r.regions[5].sustained}`); // but not throughout
  assert.ok(r.percent < 2, `percent ${r.percent}`);
  assert.equal(r.label, 'none');
});

test('a camera flash is left out of the trend and does not smear into its neighbours', () => {
  const frames = synth((c, t, k) => (k === 100 || k === 101 ? 0.55 : 0.3), { fps: 60 });
  const t = frames.map((f) => f.t), y = frames.map((f) => f.cells[0]);
  const flags = outliers(t, y, [0, y.length], 0.15);
  assert.deepEqual(flags.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [100, 101]);
  const { ratio } = detrend(t, y, 0.3);
  assert.ok(Math.abs(ratio[95] - 1) < 0.01 && Math.abs(ratio[106] - 1) < 0.01, 'neighbours untouched');
  const r = analyze(frames, layout);
  assert.ok(r.percent < 1.5, `percent ${r.percent}`);
});

test('steady alternation is flicker, never flagged as outliers', () => {
  for (const n of [29, 30, 31, 90]) {
    const t = Array.from({ length: n }, (_, k) => k / 30);
    const y = t.map((_, k) => (k % 2 ? 0.36 : 0.25));
    assert.equal(outliers(t, y, [0, n], 0.15).some(Boolean), false, `n ${n}`);
  }
});

test('flicker in a single cell is still detected', () => {
  const r = analyze(synth((c, t, k) => (c === 6 ? 0.3 * (k % 2 ? 1.2 : 0.8) : 0.3)), layout);
  assert.ok(r.whole.percent < 2.5, `whole ${r.whole.percent}`); // averaged away in the frame mean
  assert.ok(r.regions[6].percent > 18, `cell ${r.regions[6].percent}`);
  assert.equal(r.local.region, 6);
  assert.ok(r.percent >= 9, `percent ${r.percent}`);
  assert.equal(r.label, 'visible');
  assert.ok(Math.abs(r.hz - 15) < 0.3, `hz ${r.hz}`);
});

test('banded flicker that cancels in the frame average is not averaged away', () => {
  // rolling-shutter style: each row of cells flickers at 10 Hz with a different phase
  const r = analyze(synth((c, t) => 0.3 * (1 + 0.15 * Math.cos(2 * Math.PI * 10 * t + (Math.PI / 2) * Math.floor(c / GRID)))), layout);
  assert.ok(r.whole.percent < 1.5, `whole ${r.whole.percent}`);
  assert.ok(r.regional.percent > 10, `regional ${r.regional.percent}`);
  assert.ok(r.percent > 10, `percent ${r.percent}`);
  assert.ok(Math.abs(r.hz - 10) < 0.3, `hz ${r.hz}`);
});

test('uneven timestamps (dropped frames) keep the rhythm right', () => {
  const frames = synth((c, t) => 0.3 * (1 + 0.1 * Math.sin(2 * Math.PI * 7 * t)), {
    fps: 60,
    keep: (k, r) => r() > 0.25, // drop a quarter of the frames at random
  });
  const r = analyze(frames, layout);
  assert.ok(Math.abs(r.hz - 7) < 0.3, `hz ${r.hz}`);
  assert.ok(r.percent > 8, `percent ${r.percent}`);
});

test('detrend: a local linear trend is exact on ramps, including the edges', () => {
  const t = Array.from({ length: 60 }, (_, i) => i / 30);
  const y = t.map((v) => 0.2 + 0.1 * v);
  const { ratio, inner } = detrend(t, y, 0.3);
  for (const v of ratio) assert.ok(Math.abs(v - 1) < 1e-9);
  assert.equal(inner[0], 0);
  assert.equal(inner[30], 1);
});

test('Percent Flicker and Flicker Index of a sinusoid match IEEE 1789', () => {
  const t = Array.from({ length: 3000 }, (_, i) => i / 3000);
  const r = t.map((v) => 1 + 0.2 * Math.sin(2 * Math.PI * 10 * v));
  assert.ok(Math.abs(percentFlicker(r, 0, 100) - 20) < 0.01);
  assert.ok(Math.abs(flickerIndex(r, t) - 0.2 / Math.PI) < 1e-3);
});

test('too dark to measure is reported', () => {
  const frames = synth(() => 0.001).map((f) => ({ ...f, valid: new Float64Array(NC) }));
  const r = analyze(frames, layout);
  assert.equal(r.usableArea, 0);
  assert.ok(r.warnings.includes('TOO_DARK'));
});

test('end to end from pixels: a 3-frame cycle of code values 128 / 140 / 140', () => {
  // 100 Hz light at 30 fps repeats every 3 frames; the 9-frame trend averages it out exactly
  const { width, height } = layout;
  const frames = [];
  for (let k = 0; k < 120; k++) {
    const m = measureFrame(new Uint8ClampedArray(width * height * 4).fill(k % 3 ? 140 : 128), layout, 4);
    frames.push({ t: k / 30, ...m });
  }
  const r = analyze(frames, layout);
  const a = SRGB_TO_LINEAR[140], b = SRGB_TO_LINEAR[128];
  const expected = (100 * (a - b)) / (a + b); // in linear light, not code values: 9.7 %
  assert.ok(Math.abs(r.percent - expected) < 0.2, `percent ${r.percent} vs ${expected}`);
  assert.ok(Math.abs(r.hz - 10) < 0.3, `hz ${r.hz}`);
});

test('labels', () => {
  assert.equal(labelFor(0.5), 'none');
  assert.equal(labelFor(3), 'slight');
  assert.equal(labelFor(8), 'visible');
  assert.equal(labelFor(30), 'strong');
});
